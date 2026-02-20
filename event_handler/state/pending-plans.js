/**
 * In-memory store for pending plans awaiting user approval.
 * Keyed by chatId. Each entry expires after TTL_MS.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

const pending = new Map();

/**
 * Store a plan for a chat, awaiting approval.
 * @param {string} chatId
 * @param {object} plan - { project, feat_name, steps, summary, task }
 */
function setPendingPlan(chatId, plan) {
  pending.set(String(chatId), { plan, expiresAt: Date.now() + TTL_MS });
}

/**
 * Retrieve and remove a pending plan for a chat.
 * Returns null if not found or expired.
 * @param {string} chatId
 * @returns {object|null}
 */
function popPendingPlan(chatId) {
  const entry = pending.get(String(chatId));
  if (!entry) return null;
  pending.delete(String(chatId));
  if (Date.now() > entry.expiresAt) return null;
  return entry.plan;
}

/**
 * Check if a chat has a pending plan.
 */
function hasPendingPlan(chatId) {
  const entry = pending.get(String(chatId));
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pending.delete(String(chatId));
    return false;
  }
  return true;
}

/**
 * Cancel a pending plan for a chat.
 */
function cancelPendingPlan(chatId) {
  pending.delete(String(chatId));
}

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pending.entries()) {
    if (now > entry.expiresAt) pending.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { setPendingPlan, popPendingPlan, hasPendingPlan, cancelPendingPlan };
