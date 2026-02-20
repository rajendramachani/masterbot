const { chat } = require('./openrouter');
const fs = require('fs');
const path = require('path');

/**
 * Generate a task plan using the LLM.
 * Returns structured plan with project name, steps, and a human-readable summary.
 *
 * @param {string} taskDescription - The user's task request
 * @returns {Promise<{project, feat_name, steps, summary, raw}>}
 */
async function generatePlan(taskDescription) {
  const systemPrompt = loadSystemPrompt('JOB_SUMMARY.md') ||
    `You are masterbot, an autonomous AI coding agent orchestrator. 
You help users plan software development tasks that will be executed by an AI coding agent (Pi) on GitHub.

When given a task, you must respond with a JSON object (no markdown, no code fences) with this exact structure:
{
  "project": "short-project-name",
  "feat_name": "short-feature-slug",
  "steps": ["step 1 description", "step 2 description", "..."],
  "summary": "A clear 2-3 sentence plan summary for the user",
  "estimated_minutes": 10
}

Rules:
- "project" must be lowercase letters, numbers, hyphens only (e.g. "my-app", "api-service")
- "feat_name" must be lowercase letters, numbers, hyphens only, max 30 chars (e.g. "add-login-page")
- "steps" should be 3-6 concrete implementation steps the AI agent will take
- "summary" should be friendly and explain what will be built and how
- "estimated_minutes" is a realistic estimate for the coding agent to complete the task`;

  const messages = [
    { role: 'user', content: `Plan this task for the AI coding agent:\n\n${taskDescription}` },
  ];

  let raw;
  try {
    raw = await chat({ systemPrompt, messages, maxTokens: 512 });
  } catch (err) {
    throw new Error(`LLM planning failed: ${err.message}`);
  }

  // Parse JSON — strip any accidental markdown fences
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch (_) {
    // Fallback: extract JSON object from response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { plan = JSON.parse(match[0]); } catch (_2) {}
    }
  }

  if (!plan || !plan.project || !plan.feat_name) {
    // Graceful fallback — derive from task text
    const slug = taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 30);
    plan = {
      project: slug.split('-').slice(0, 2).join('-') || 'my-project',
      feat_name: slug || 'new-feature',
      steps: ['Analyze requirements', 'Implement solution', 'Write tests', 'Commit changes'],
      summary: `I'll implement: ${taskDescription}`,
      estimated_minutes: 10,
    };
  }

  // Sanitize project and feat_name
  plan.project = plan.project.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 40);
  plan.feat_name = plan.feat_name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 40);

  return { ...plan, raw };
}

/**
 * Generate a chat response using the LLM (for non-task messages).
 */
async function generateChatResponse(userMessage, history) {
  const systemPrompt = loadSystemPrompt('CHATBOT.md') ||
    `You are masterbot, a friendly AI assistant that helps developers manage coding tasks via Telegram.
You can help users plan tasks, answer questions about their projects, and explain what you can do.
When a user wants to build something or create code, encourage them to describe their task and you'll plan it for them.
Keep responses concise and helpful. You communicate via Telegram so avoid very long responses.`;

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  return chat({ systemPrompt, messages, maxTokens: 512 });
}

/**
 * Summarize a completed job for Telegram notification.
 */
async function summarizeJob(results) {
  const systemPrompt = loadSystemPrompt('JOB_SUMMARY.md') ||
    `You are masterbot. Summarize a completed AI coding agent job for the user in a friendly, concise Telegram message.
Include: what was built, key files changed, PR link. Keep it under 300 words. No markdown headers.`;

  const userMessage = [
    results.task ? `## Task\n${results.task}` : '',
    results.commit_message ? `## Commit\n${results.commit_message}` : '',
    results.changed_files?.length ? `## Files Changed\n${results.changed_files.join('\n')}` : '',
    results.pr_status ? `## PR Status\n${results.pr_status}` : '',
    results.pr_url ? `## PR URL\n${results.pr_url}` : '',
  ].filter(Boolean).join('\n\n');

  try {
    return await chat({
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 512,
    });
  } catch (err) {
    console.error('[planner] summarizeJob failed:', err.message);
    return results.pr_url
      ? `Job completed! PR: ${results.pr_url}`
      : 'Job completed.';
  }
}

/**
 * Load a system prompt from operating_system/ directory.
 */
function loadSystemPrompt(filename) {
  try {
    const p = path.join(__dirname, '..', '..', 'operating_system', filename);
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { generatePlan, generateChatResponse, summarizeJob };
