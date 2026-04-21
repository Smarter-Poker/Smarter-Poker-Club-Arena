// Anthropic Messages API client — direct fetch, no SDK.
// Docs: https://docs.claude.com/en/api/messages
//
// Automatic prompt caching:
//   When `system` is a string (the common case), it's wrapped in the
//   cache-eligible array form `[{type:'text', text, cache_control:{type:'ephemeral'}}]`.
//   Our autofix SYSTEM_PROMPT is static across thousands of calls, so the
//   5-minute TTL cache hit rate is ~95% in steady state and cuts input-cost
//   ~10× for the cached portion.
//
//   Pass { cachePrompt: false } to opt out (e.g. if a caller is passing a
//   dynamic system prompt). Pass an array directly for full control.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Call Claude.
 * @param {object} opts
 * @param {string} opts.model          e.g. "claude-opus-4-6"
 * @param {string|Array} opts.system   system prompt (string cached by default)
 * @param {Array<{role,content}>} opts.messages
 * @param {number} [opts.maxTokens=8192]
 * @param {number} [opts.temperature=0]
 * @param {boolean} [opts.cachePrompt=true]  wrap string system in ephemeral cache
 * @returns {Promise<{text:string, stopReason:string, usage:object, raw:object}>}
 */
export async function callClaude({
  model,
  system,
  messages,
  maxTokens = 8192,
  temperature = 0,
  cachePrompt = true,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  // Wrap string system prompt in cache-eligible form. If caller already passed
  // an array, trust them — they may be mixing cached + uncached blocks.
  let systemField = system;
  if (cachePrompt && typeof system === 'string' && system.length > 0) {
    systemField = [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ];
  }

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemField,
    messages,
  });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 800)}`);
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return { text, stopReason: json.stop_reason, usage: json.usage, raw: json };
}
