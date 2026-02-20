const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Call OpenRouter chat completions API.
 *
 * @param {object} opts
 * @param {string}   opts.model      - OpenRouter model ID (default from env or 'openai/gpt-4o-mini')
 * @param {Array}    opts.messages   - Chat messages array [{role, content}]
 * @param {number}   [opts.maxTokens=1024]
 * @param {string}   [opts.systemPrompt] - Optional system prompt prepended to messages
 * @returns {Promise<string>} The assistant's reply text
 */
async function chat({ model, messages, maxTokens = 1024, systemPrompt }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const resolvedModel = model || process.env.EVENT_HANDLER_MODEL || 'openai/gpt-4o-mini';

  const fullMessages = [];
  if (systemPrompt) {
    fullMessages.push({ role: 'system', content: systemPrompt });
  }
  fullMessages.push(...messages);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  let res;
  try {
    res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/rajendramachani/masterbot',
        'X-Title': 'masterbot',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
        messages: fullMessages,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return content.trim();
}

module.exports = { chat };
