const fs = require('fs');
const path = require('path');

/**
 * Load webhook triggers from TRIGGERS.json in operating_system/.
 * Returns an Express middleware that handles configured trigger routes.
 */
function loadTriggers() {
  const triggersPath = path.join(__dirname, '..', 'operating_system', 'TRIGGERS.json');
  let triggers = [];

  if (fs.existsSync(triggersPath)) {
    try {
      triggers = JSON.parse(fs.readFileSync(triggersPath, 'utf8'));
    } catch (err) {
      console.error('[triggers] Failed to parse TRIGGERS.json:', err.message);
    }
  }

  return (req, res, next) => {
    const match = triggers.find(t => t.path && req.path === t.path && req.method === (t.method || 'POST'));
    if (!match) return next();

    console.log(`[triggers] Matched trigger: ${match.description || match.path}`);
    res.status(200).json({ ok: true, trigger: match.path });
  };
}

module.exports = { loadTriggers };
