'use strict';

// Anthropic Messages API call with a timeout, one retry for temporary errors,
// and a classified result. Pure apart from the injected fetch/sleep, so it's
// unit-testable. Never logs or returns the API key.

const API_URL = 'https://api.anthropic.com/v1/messages';
// The one place the model is set, for both guest replies and post-checkout
// summaries. 'claude-sonnet-5' is the planned next step once the prompt holds
// up on it in the replay (see README "Model and prompt caching").
const MODEL = 'claude-sonnet-4-6';
// Thinking explicitly off: Sonnet 5 runs adaptive thinking when the field is
// omitted (Sonnet 4.6 did not), and thinking tokens count against the small
// max_tokens used for 1-3 sentence replies. Valid on both models.
const THINKING = { type: 'disabled' };
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
    default: return `Claude API error ${err.status || ''}: ${String(err.message || '').slice(0, 120)}`.trim();
  }
}

async function attempt({ fetchImpl, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const message = data?.error?.message || `HTTP ${res.status}`;
      return { ok: false, status: res.status, errorType: classifyError(res.status, message), message };
    }
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
  const body = { model, max_tokens: maxTokens, system, messages, thinking: THINKING };
  let result = await attempt({ fetchImpl, apiKey, body, timeoutMs });
  let attempts = 1;
  if (!result.ok) {
    log.warn(`callClaude: attempt 1 failed — ${result.errorType}${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message}`);
    if (isRetryable(result.errorType)) {
      await sleep(retryDelayMs);
      result = await attempt({ fetchImpl, apiKey, body, timeoutMs });
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
  classifyError,
  isRetryable,
  describeClaudeError,
  callClaudeWithRetry,
  buildCachedSystem,
  formatUsage,
};
