'use strict';

// Anthropic Messages API call with a timeout, one retry for temporary errors,
// and a classified result. Pure apart from the injected fetch/sleep, so it's
// unit-testable. Never logs or returns the API key.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
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
    const text = data?.content?.[0]?.text || '';
    if (!text) return { ok: false, status: res.status, errorType: 'empty_response', message: `stop_reason=${data?.stop_reason || 'unknown'}` };
    return { ok: true, text, stopReason: data?.stop_reason };
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
  apiKey, system, messages, maxTokens = 500,
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, log = console,
}) {
  const body = { model: MODEL, max_tokens: maxTokens, system, messages };
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
  return { ...result, attempts };
}

module.exports = {
  MODEL,
  classifyError,
  isRetryable,
  describeClaudeError,
  callClaudeWithRetry,
};
