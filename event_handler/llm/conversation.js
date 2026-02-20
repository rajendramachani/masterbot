/**
 * In-memory conversation history per chat ID.
 * Keeps the last N turns to avoid unbounded growth.
 */

const MAX_HISTORY = 20;
const histories = new Map();

function getHistory(chatId) {
  return histories.get(String(chatId)) || [];
}

function updateHistory(chatId, messages) {
  const trimmed = messages.slice(-MAX_HISTORY);
  histories.set(String(chatId), trimmed);
}

function clearHistory(chatId) {
  histories.delete(String(chatId));
}

module.exports = { getHistory, updateHistory, clearHistory };
