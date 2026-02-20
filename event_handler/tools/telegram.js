const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Set a Telegram webhook URL for a bot.
 */
async function setWebhook(botToken, webhookUrl, secret) {
  const body = { url: webhookUrl };
  if (secret) body.secret_token = secret;

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`setWebhook failed: ${res.status}`);
  return res.json();
}

/**
 * Send a text message to a Telegram chat.
 * Auto-splits messages longer than 4096 chars.
 */
async function sendMessage(botToken, chatId, text) {
  const MAX = 4096;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) {
    chunks.push(text.slice(i, i + MAX));
  }

  for (const chunk of chunks) {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[telegram] sendMessage failed:', err);
    }
  }
}

/**
 * React to a message with a thumbs up emoji.
 */
async function reactToMessage(botToken, chatId, messageId) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn('[telegram] reactToMessage failed:', err);
  }
}

/**
 * Start a typing indicator that repeats every 4s until stopped.
 * Returns a stop function.
 */
function startTypingIndicator(botToken, chatId) {
  const send = () =>
    fetch(`${TELEGRAM_API}/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => {});

  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

/**
 * Download a file from Telegram (e.g. voice message).
 * Returns { buffer, filename }.
 */
async function downloadFile(botToken, fileId) {
  const fileRes = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`);
  if (!fileRes.ok) throw new Error(`getFile failed: ${fileRes.status}`);
  const { result } = await fileRes.json();
  const filePath = result.file_path;
  const filename = filePath.split('/').pop();

  const dlRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!dlRes.ok) throw new Error(`download failed: ${dlRes.status}`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  return { buffer, filename };
}

module.exports = { setWebhook, sendMessage, reactToMessage, startTypingIndicator, downloadFile };
