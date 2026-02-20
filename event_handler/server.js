require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const path = require('path');

const { setWebhook, sendMessage, reactToMessage, startTypingIndicator, downloadFile } = require('./tools/telegram');
const { createJobBranch, getJobStatus } = require('./tools/github');
const { generatePlan, generateChatResponse, summarizeJob } = require('./llm/planner');
const { getHistory, updateHistory } = require('./llm/conversation');
const { setPendingPlan, popPendingPlan, hasPendingPlan, cancelPendingPlan } = require('./state/pending-plans');
const { loadCrons } = require('./cron');
const { loadTriggers } = require('./triggers');

const app = express();

app.use(helmet());
app.use(express.json());

const {
  API_KEY,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_VERIFICATION,
  GH_WEBHOOK_SECRET,
} = process.env;

let telegramBotToken = TELEGRAM_BOT_TOKEN || null;

// Routes with their own auth
const PUBLIC_ROUTES = ['/telegram/webhook', '/github/webhook'];

// Global x-api-key auth
app.use((req, res, next) => {
  if (PUBLIC_ROUTES.includes(req.path)) return next();
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.use(loadTriggers());

// GET /ping - health check
app.get('/ping', (req, res) => {
  res.json({ message: 'Pong!', service: 'masterbot-event-handler' });
});

// GET /jobs/status
app.get('/jobs/status', async (req, res) => {
  try {
    const result = await getJobStatus(req.query.job_id);
    res.json(result);
  } catch (err) {
    console.error('[server] getJobStatus failed:', err);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// POST /webhook - create a job directly (API access)
app.post('/webhook', async (req, res) => {
  const { task, project, feat_name } = req.body;
  if (!task) return res.status(400).json({ error: 'Missing task field' });

  try {
    const result = await createJobBranch({ project: project || 'default', task, feat_name });
    res.json(result);
  } catch (err) {
    console.error('[server] /webhook failed:', err);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// POST /telegram/register - register Telegram webhook
app.post('/telegram/register', async (req, res) => {
  const { bot_token, webhook_url } = req.body;
  if (!bot_token || !webhook_url) {
    return res.status(400).json({ error: 'Missing bot_token or webhook_url' });
  }
  try {
    const result = await setWebhook(bot_token, webhook_url, TELEGRAM_WEBHOOK_SECRET);
    telegramBotToken = bot_token;
    res.json({ success: true, result });
  } catch (err) {
    console.error('[server] setWebhook failed:', err);
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// POST /telegram/webhook - receive Telegram updates
app.post('/telegram/webhook', async (req, res) => {
  // Validate secret token
  if (TELEGRAM_WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== TELEGRAM_WEBHOOK_SECRET) {
      return res.status(200).json({ ok: true });
    }
  }

  const update = req.body;
  const message = update.message || update.edited_message;

  if (!message || !message.chat || !telegramBotToken) {
    return res.status(200).json({ ok: true });
  }

  const chatId = String(message.chat.id);
  let messageText = message.text || null;

  // Verification code check (works before TELEGRAM_CHAT_ID is set)
  if (TELEGRAM_VERIFICATION && messageText === TELEGRAM_VERIFICATION) {
    await sendMessage(telegramBotToken, chatId, `Your chat ID:\n${chatId}`);
    return res.status(200).json({ ok: true });
  }

  // Security: only accept messages from configured chat
  if (!TELEGRAM_CHAT_ID) return res.status(200).json({ ok: true });
  if (chatId !== TELEGRAM_CHAT_ID) return res.status(200).json({ ok: true });

  // React with thumbs up
  await reactToMessage(telegramBotToken, chatId, message.message_id).catch(() => {});

  // Acknowledge immediately so Telegram doesn't retry
  res.status(200).json({ ok: true });

  if (!messageText) return;

  const stopTyping = startTypingIndicator(telegramBotToken, chatId);

  try {
    await handleTelegramMessage(chatId, messageText);
  } catch (err) {
    console.error('[server] handleTelegramMessage failed:', err);
    await sendMessage(telegramBotToken, chatId, 'Sorry, I encountered an error. Please try again.').catch(() => {});
  } finally {
    stopTyping();
  }
});

/**
 * Core message handler — implements the plan/approval flow.
 *
 * Flow:
 *   1. User sends a task description
 *   2. Bot generates a plan (project name, steps, estimate) via LLM
 *   3. Bot sends plan to user and asks for approval
 *   4. User approves → bot creates feat branch + job.md → Pi agent runs
 *   5. User rejects/cancels → plan discarded
 *   6. User modifies → re-plan with feedback
 *   7. Non-task messages → LLM chat response
 */
async function handleTelegramMessage(chatId, text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // --- Approval flow: user has a pending plan ---
  if (hasPendingPlan(chatId)) {
    // Approval keywords
    if (/^(yes|approve|go|ok|proceed|confirm|start|do it|looks good|lgtm|y)$/i.test(lower)) {
      const plan = popPendingPlan(chatId);
      if (!plan) {
        await sendMessage(telegramBotToken, chatId, 'Your plan expired. Please describe your task again.');
        return;
      }

      await sendMessage(telegramBotToken, chatId,
        `Starting the job...\n\nProject: ${plan.project}\nBranch: feat/${plan.feat_name}\n\nThe Pi coding agent will pick this up shortly.`
      );

      try {
        const result = await createJobBranch({
          project: plan.project,
          task: plan.task,
          feat_name: plan.feat_name,
        });

        const msg = [
          `Job created!`,
          ``,
          `Project: ${result.project}`,
          `Branch: ${result.branch}`,
          `PR: ${result.pr_url}`,
          ``,
          `The Pi coding agent is now running. I'll notify you when it's done.`,
        ].join('\n');

        await sendMessage(telegramBotToken, chatId, msg);

        // Add to conversation history
        const history = getHistory(chatId);
        history.push({ role: 'assistant', content: msg });
        updateHistory(chatId, history);

      } catch (err) {
        console.error('[server] createJobBranch failed:', err);
        await sendMessage(telegramBotToken, chatId, `Failed to create job: ${err.message}`);
      }
      return;
    }

    // Cancellation keywords
    if (/^(no|cancel|abort|stop|nope|n)$/i.test(lower)) {
      cancelPendingPlan(chatId);
      await sendMessage(telegramBotToken, chatId, 'Plan cancelled. Let me know if you want to try a different task.');
      return;
    }

    // Modification: user gave feedback — re-plan
    const existingPlan = popPendingPlan(chatId);
    if (existingPlan) {
      await sendMessage(telegramBotToken, chatId, 'Got it, let me revise the plan...');
      const revisedTask = `${existingPlan.task}\n\nUser feedback: ${trimmed}`;
      await planAndPresent(chatId, revisedTask);
      return;
    }
  }

  // --- Detect if this is a task request or a chat message ---
  const isTaskRequest = await classifyIntent(trimmed, getHistory(chatId));

  if (isTaskRequest) {
    await sendMessage(telegramBotToken, chatId, 'Let me plan that for you...');
    await planAndPresent(chatId, trimmed);
  } else {
    // Regular chat — LLM response
    const history = getHistory(chatId);
    const response = await generateChatResponse(trimmed, history);

    const newHistory = [
      ...history,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: response },
    ];
    updateHistory(chatId, newHistory);

    await sendMessage(telegramBotToken, chatId, response);
  }
}

/**
 * Generate a plan and present it to the user for approval.
 */
async function planAndPresent(chatId, task) {
  let plan;
  try {
    plan = await generatePlan(task);
  } catch (err) {
    console.error('[server] generatePlan failed:', err);
    await sendMessage(telegramBotToken, chatId, `Sorry, I couldn't generate a plan: ${err.message}`);
    return;
  }

  // Store plan with original task text
  setPendingPlan(chatId, { ...plan, task });

  // Format plan message
  const stepsText = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const planMsg = [
    `Here's my plan:`,
    ``,
    `Project: ${plan.project}`,
    `Feature: ${plan.feat_name}`,
    `Estimated time: ~${plan.estimated_minutes || 10} minutes`,
    ``,
    `Steps:`,
    stepsText,
    ``,
    plan.summary,
    ``,
    `Reply "yes" to approve and start, "no" to cancel, or describe any changes you'd like.`,
  ].join('\n');

  await sendMessage(telegramBotToken, chatId, planMsg);
}

/**
 * Classify whether a message is a task request or a chat message.
 * Uses simple heuristics first, falls back to LLM for ambiguous cases.
 */
async function classifyIntent(text, history) {
  const lower = text.toLowerCase();

  // Clear task indicators
  const taskKeywords = [
    'build', 'create', 'make', 'add', 'implement', 'write', 'develop', 'generate',
    'fix', 'refactor', 'update', 'migrate', 'set up', 'setup', 'deploy', 'scaffold',
    'integrate', 'connect', 'configure', 'install', 'init', 'bootstrap',
  ];
  if (taskKeywords.some(kw => lower.includes(kw))) return true;

  // Clear chat indicators
  const chatKeywords = ['hello', 'hi', 'hey', 'how are', 'what can you', 'help me understand',
    'explain', 'what is', 'who are', 'thanks', 'thank you', 'status'];
  if (chatKeywords.some(kw => lower.includes(kw))) return false;

  // Short messages are usually chat
  if (text.length < 20) return false;

  // LLM classification for ambiguous cases
  try {
    const { chat } = require('./llm/openrouter');
    const response = await chat({
      systemPrompt: 'You classify messages as either "task" (user wants to build/create/modify code) or "chat" (conversation). Reply with only the word "task" or "chat".',
      messages: [{ role: 'user', content: text }],
      maxTokens: 5,
    });
    return response.toLowerCase().includes('task');
  } catch (_) {
    // Default to chat on LLM failure
    return false;
  }
}

/**
 * Extract job ID from branch name (e.g. "feat/abc123" -> "abc123")
 */
function extractJobId(branchName) {
  if (!branchName || !branchName.startsWith('feat/')) return null;
  return branchName.slice(5);
}

// POST /github/webhook - receive GitHub PR notifications from update-event-handler.yml
app.post('/github/webhook', async (req, res) => {
  if (GH_WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-github-webhook-secret-token'];
    if (headerSecret !== GH_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  if (event !== 'pull_request') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const pr = payload.pull_request;
  if (!pr) return res.status(200).json({ ok: true, skipped: true });

  const branchName = pr.head?.ref;
  const jobId = extractJobId(branchName);
  if (!jobId) return res.status(200).json({ ok: true, skipped: true, reason: 'not a feat branch' });

  if (!TELEGRAM_CHAT_ID || !telegramBotToken) {
    console.log(`[server] Job ${jobId} completed but no chat configured`);
    return res.status(200).json({ ok: true, skipped: true, reason: 'no chat configured' });
  }

  try {
    const results = payload.job_results || {};
    results.pr_url = pr.html_url;

    const message = await summarizeJob(results);
    await sendMessage(telegramBotToken, TELEGRAM_CHAT_ID, message);

    // Add to conversation memory
    const history = getHistory(TELEGRAM_CHAT_ID);
    history.push({ role: 'assistant', content: message });
    updateHistory(TELEGRAM_CHAT_ID, history);

    console.log(`[server] Notified chat ${TELEGRAM_CHAT_ID} about job ${jobId.slice(0, 8)}`);
    res.status(200).json({ ok: true, notified: true });
  } catch (err) {
    console.error('[server] GitHub webhook processing failed:', err);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`masterbot event handler listening on port ${PORT}`);
  loadCrons();
});
