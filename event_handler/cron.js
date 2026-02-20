const fs = require('fs');
const path = require('path');

/**
 * Load and schedule cron jobs from CRONS.json in operating_system/.
 * Each entry: { schedule, job, description }
 */
function loadCrons() {
  const cronsPath = path.join(__dirname, '..', 'operating_system', 'CRONS.json');
  if (!fs.existsSync(cronsPath)) {
    console.log('[cron] No CRONS.json found — skipping cron setup');
    return;
  }

  let crons;
  try {
    crons = JSON.parse(fs.readFileSync(cronsPath, 'utf8'));
  } catch (err) {
    console.error('[cron] Failed to parse CRONS.json:', err.message);
    return;
  }

  if (!Array.isArray(crons) || crons.length === 0) {
    console.log('[cron] No cron jobs configured');
    return;
  }

  try {
    const cron = require('node-cron');
    for (const entry of crons) {
      if (!entry.schedule || !entry.job) continue;
      cron.schedule(entry.schedule, () => {
        console.log(`[cron] Running: ${entry.description || entry.job}`);
      });
      console.log(`[cron] Scheduled: ${entry.description || entry.job} (${entry.schedule})`);
    }
  } catch (err) {
    console.warn('[cron] node-cron not available:', err.message);
  }
}

module.exports = { loadCrons };
