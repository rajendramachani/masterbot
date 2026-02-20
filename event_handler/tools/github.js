const { GH_TOKEN, GH_OWNER, GH_REPO } = process.env;

const GH_API_TIMEOUT_MS = parseInt(process.env.GH_API_TIMEOUT_MS || '30000', 10);

/**
 * GitHub REST API helper with authentication.
 */
async function githubApi(endpoint, options = {}) {
  const url = endpoint.startsWith('https://')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_API_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Create a job branch (feat/<feat_id>) under a project's dev branch.
 * Ensures project branch hierarchy exists first.
 *
 * @param {object} opts
 * @param {string} opts.project    - Project name (e.g. 'my-app')
 * @param {string} opts.task       - Task description (written to job.md)
 * @param {string} opts.feat_name  - Feature branch suffix (slugified task title)
 * @returns {Promise<{feat_id, branch, project, dev_branch, pr_number, pr_url}>}
 */
async function createJobBranch({ project, task, feat_name }) {
  const repo = `/repos/${GH_OWNER}/${GH_REPO}`;
  const masterBranch = `${project}-master`;
  const devBranch = `${project}-dev`;

  // Ensure project-master exists (orphan if needed)
  await ensureProjectBranches(repo, project, masterBranch, devBranch);

  // Create feat branch off project-dev
  const { v4: uuidv4 } = require('uuid');
  const featId = feat_name
    ? feat_name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase().slice(0, 40)
    : uuidv4();
  const branch = `feat/${featId}`;

  // Get dev branch SHA
  const baseRef = await githubApi(`${repo}/git/ref/heads/${devBranch}`);
  const baseSha = baseRef.object.sha;

  // Create feat branch
  try {
    await githubApi(`${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    console.warn(`[github] Branch ${branch} already exists — continuing`);
  }

  // Write structured job.md onto the feat branch (includes project metadata for the agent)
  const jobMd = [
    `<!-- masterbot-meta project="${project}" dev_branch="${devBranch}" feat_id="${featId}" -->`,
    ``,
    `# Task`,
    ``,
    task,
  ].join('\n');
  const jobContent = Buffer.from(jobMd).toString('base64');
  let existingSha;
  try {
    const existing = await githubApi(`${repo}/contents/logs/${featId}/job.md?ref=${branch}`);
    existingSha = existing.sha;
  } catch (_) {}

  const fileBody = {
    message: `chore(masterbot): add job for ${featId.slice(0, 8)}`,
    content: jobContent,
    branch,
  };
  if (existingSha) fileBody.sha = existingSha;

  await githubApi(`${repo}/contents/logs/${featId}/job.md`, {
    method: 'PUT',
    body: JSON.stringify(fileBody),
  });

  // Dispatch run-job.yml workflow to run the Pi coding agent on the feat branch
  try {
    await githubApi(`${repo}/actions/workflows/run-job.yml/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        inputs: { branch },
      }),
    });
    console.log(`[github] Dispatched run-job.yml for branch: ${branch}`);
  } catch (err) {
    console.warn(`[github] workflow dispatch failed: ${err.message}`);
  }

  // PR is opened by the agent after it commits generated code — not here.
  const repoUrl = `https://github.com/${GH_OWNER}/${GH_REPO}`;
  return {
    feat_id: featId,
    branch,
    project,
    dev_branch: devBranch,
    pr_number: null,
    pr_url: `${repoUrl}/compare/${devBranch}...${branch}`,
  };
}

/**
 * Ensure project-master (orphan) and project-dev branches exist.
 */
async function ensureProjectBranches(repo, project, masterBranch, devBranch) {
  // Check if project-master exists
  let masterExists = false;
  try {
    await githubApi(`${repo}/git/ref/heads/${masterBranch}`);
    masterExists = true;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  if (!masterExists) {
    // Create orphan project-master with a placeholder commit
    const blob = await githubApi(`${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: `# ${project}\n\nProject branch managed by masterbot.\n`, encoding: 'utf-8' }),
    });
    const tree = await githubApi(`${repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }] }),
    });
    const commit = await githubApi(`${repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `chore(gitops): bootstrap ${masterBranch}`,
        tree: tree.sha,
        parents: [],
      }),
    });
    try {
      await githubApi(`${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${masterBranch}`, sha: commit.sha }),
      });
      console.log(`[github] Created orphan branch: ${masterBranch}`);
    } catch (err) {
      if (err.status !== 422) throw err;
    }
  }

  // Ensure project-dev exists (fork from project-master)
  try {
    await githubApi(`${repo}/git/ref/heads/${devBranch}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    const masterRef = await githubApi(`${repo}/git/ref/heads/${masterBranch}`);
    try {
      await githubApi(`${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${devBranch}`, sha: masterRef.object.sha }),
      });
      console.log(`[github] Created branch: ${devBranch}`);
    } catch (createErr) {
      if (createErr.status !== 422) throw createErr;
    }
  }
}

/**
 * Get the status of a job branch (checks if PR exists and its state).
 */
async function getJobStatus(jobId) {
  const repo = `/repos/${GH_OWNER}/${GH_REPO}`;
  try {
    const prs = await githubApi(`${repo}/pulls?head=${encodeURIComponent(`${GH_OWNER}:feat/${jobId}`)}&state=all`);
    if (prs.length === 0) return { status: 'not_found', job_id: jobId };
    const pr = prs[0];
    return {
      status: pr.state,
      merged: pr.merged_at !== null,
      pr_number: pr.number,
      pr_url: pr.html_url,
      job_id: jobId,
    };
  } catch (err) {
    return { status: 'error', error: err.message, job_id: jobId };
  }
}

module.exports = { githubApi, createJobBranch, getJobStatus };
