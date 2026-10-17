'use strict';

// Anthropic Messages API call with a timeout, one retry for temporary errors,
// and a classified result. Pure apart from the injected fetch/sleep, so it's
// unit-testable. Never logs or returns the API key.

const API_URL = 'https://api.anthropic.com/v1/messages';
// The one place the model is set, for both guest replies and post-checkout
// summaries. Switching to Sonnet 5.5 is this one line once the owner approves
// (see requestBodyFor: the request shape per model is already handled).
const MODEL = 'claude-sonnet-4-6';
// Thinking explicitly off on Sonnet 4.6 / 5 (thinking tokens would count
// against the small max_tokens used for 1-3 sentence replies).
const THINKING = { type: 'disabled' };
// Sonnet 5.5 server-side fallback: a request its safety filter declines (e.g.
// "reasoning_extraction" on a history with leaked bot reasoning) is re-run on
// a fallback model instead of returning nothing.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Request body + extra headers for `model`:
 * - Sonnet 4.6: thinking disabled (unchanged).
 * - Sonnet 5: thinking disabled; ~30% more tokens for the same text (new tokenizer).
 * - Sonnet 5.5: "disabled" thinking is a 400 there; adaptive thinking at low
 *   effort instead (Anthropic's recommended replacement), room for thinking
 *   in max_tokens, and the server-side refusal fallback.
 */
function requestBodyFor(model, { system, messages, maxTokens }) {
  if (/^claude-sonnet-5-5/.test(model)) {
    return {
      body: { model, max_tokens: Math.max(1500, maxTokens * 3), system, messages, output_config: { effort: 'low' }, fallbacks: 'default' },
      headers: { 'anthropic-beta': FALLBACK_BETA },
    };
  }
  if (/^claude-sonnet-5(?!-\d)/.test(model)) {
    return { body: { model, max_tokens: Math.ceil(maxTokens * 1.3), system, messages, thinking: THINKING }, headers: {} };
  }
  return { body: { model, max_tokens: maxTokens, system, messages, thinking: THINKING }, headers: {} };
}
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_RETRY_DELAY_MS = 2000;

/** Maps an HTTP status + API error message to a short error type. */
function classifyError(status, message) {
  if (status === 400 && /credit balance/i.test(message || '')) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Temporary errors worth one retry. 400/401/403 and an empty credit balance never are. */
function isRetryable(errorType) {
  return ['rate_limit', 'overloaded', 'server', 'timeout', 'network'].includes(errorType);
}

/** Plain-language description for the owner's WhatsApp notification. */
function describeClaudeError(err) {
  switch (err.errorType) {
    case 'credit': return 'Claude credit is empty';
    case 'auth': return `Claude API key was rejected (${err.status})`;
    case 'rate_limit': return 'Claude API error 429 (rate limit)';
    case 'overloaded': return 'Claude API error 529 (overloaded)';
    case 'server': return `Claude API error ${err.status}`;
    case 'timeout': return 'Claude did not answer in time';
    case 'network': return 'could not reach the Claude API';
    case 'empty_response': return 'Claude returned an empty reply';
    case 'refusal': return 'Claude declined to answer (safety filter)';
    default: return `Claude API error ${err.status || ''}: ${String(err.message || '').slice(0, 120)}`.trim();
  }
}

async function attempt({ fetchImpl, apiKey, body, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const message = data?.error?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, errorType: classifyError(res.status, message), message };
    }
    // A declined request (safety filter) has no usable text: never sent to the guest.
    if (data?.stop_reason === 'refusal') return { ok: false, status: res.status, errorType: 'refusal', message: `refusal${data?.stop_details?.category ? ` (${data.stop_details.category})` : ''}`, usage: data?.usage };
    // First text block, not content[0]: a thinking block could come first.
    const text = (data?.content || []).find((b) => b?.type === 'text')?.text || '';
    if (!text) return { ok: false, status: res.status, errorType: 'empty_response', message: `stop_reason=${data?.stop_reason || 'unknown'}`, usage: data?.usage };
    return { ok: true, text, stopReason: data?.stop_reason, usage: data?.usage };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, errorType: 'timeout', message: `no response within ${timeoutMs} ms` };
    return { ok: false, errorType: 'network', message: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Claude; on a temporary error waits `retryDelayMs` and tries once more.
 * Returns { ok: true, text, attempts } or { ok: false, errorType, status, message, attempts }.
 */
async function callClaudeWithRetry({
  apiKey, system, messages, maxTokens = 500, model = MODEL,
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, log = console,
}) {
  const { body, headers } = requestBodyFor(model, { system, messages, maxTokens });
  let result = await attempt({ fetchImpl, apiKey, body, headers, timeoutMs });
  let attempts = 1;
  if (!result.ok) {
    log.warn(`callClaude: attempt 1 failed — ${result.errorType}${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message}`);
    if (isRetryable(result.errorType)) {
      await sleep(retryDelayMs);
      result = await attempt({ fetchImpl, apiKey, body, headers, timeoutMs });
      attempts = 2;
      if (!result.ok) log.error(`callClaude: attempt 2 failed — ${result.errorType}${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message}`);
    }
  }
  if (result.ok && result.stopReason === 'max_tokens') {
    log.warn(`callClaude: reply hit max_tokens (${maxTokens}) and may be cut off`);
  }
  return { ...result, model, attempts };
}

/**
 * System prompt as two blocks for prompt caching: the long fixed prompt first,
 * marked cache_control (cached for 5 minutes, refreshed on every hit), then
 * the per-guest part (guest context, mode, times) after the breakpoint so it
 * never invalidates the cache. Anything that changes per request must stay in
 * `dynamicText`.
 */
function buildCachedSystem(fixedText, dynamicText) {
  const blocks = [{ type: 'text', text: fixedText, cache_control: { type: 'ephemeral' } }];
  if (dynamicText) blocks.push({ type: 'text', text: dynamicText });
  return blocks;
}

/** One-line token usage for the logs, e.g. "in 212 · cache write 0 · cache read 8150 · out 41". */
function formatUsage(usage) {
  if (!usage) return 'usage unavailable';
  return `in ${usage.input_tokens ?? '?'} · cache write ${usage.cache_creation_input_tokens ?? 0} · cache read ${usage.cache_read_input_tokens ?? 0} · out ${usage.output_tokens ?? '?'}`;
}

module.exports = {
  MODEL,
  requestBodyFor,
  classifyError,
  isRetryable,
  describeClaudeError,
  callClaudeWithRetry,
  buildCachedSystem,
  formatUsage,
};
