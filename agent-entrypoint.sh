#!/bin/bash
set -e

# Extract feat ID from branch name (feat/<id> -> <id>), fallback to random UUID
if [[ "$BRANCH" == feat/* ]]; then
    FEAT_ID="${BRANCH#feat/}"
else
    FEAT_ID=$(cat /proc/sys/kernel/random/uuid)
fi
echo "Feat ID: ${FEAT_ID}"

# Start Chrome (using Puppeteer's chromium from pi-skills browser-tools)
CHROME_BIN=$(find /root/.cache/puppeteer -name "chrome" -type f | head -1)
if [ -n "$CHROME_BIN" ]; then
    $CHROME_BIN --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 2>/dev/null &
    CHROME_PID=$!
    sleep 2
fi

# Export SECRETS (base64 JSON) as flat env vars
# These are filtered from LLM's bash subprocess by env-sanitizer extension
if [ -n "$SECRETS" ]; then
    SECRETS_JSON=$(echo "$SECRETS" | base64 -d)
    eval $(echo "$SECRETS_JSON" | jq -r 'to_entries | .[] | "export \(.key)=\"\(.value)\""')
    export SECRETS="$SECRETS_JSON"
else
    echo "WARNING: SECRETS env var is empty!"
fi

# Validate GH_TOKEN
if [ -z "$GH_TOKEN" ]; then
    echo "ERROR: GH_TOKEN is empty after decoding SECRETS"
    exit 1
else
    echo "GH_TOKEN is set (length: ${#GH_TOKEN})"
fi

# Export LLM_SECRETS (base64 JSON) as flat env vars
# These are NOT filtered — LLM can access these (API keys, browser logins, etc.)
if [ -n "$LLM_SECRETS" ]; then
    LLM_SECRETS_JSON=$(echo "$LLM_SECRETS" | base64 -d)
    eval $(echo "$LLM_SECRETS_JSON" | jq -r 'to_entries | .[] | "export \(.key)=\"\(.value)\""')
fi

# ============================================================
# Git authentication setup — hardened against gh CLI conflicts
# ============================================================
# gh CLI auto-registers as a git credential helper and intercepts all git auth,
# causing "502 Failed to authenticate request with Clerk" errors.
# Fix: use token-in-URL authentication exclusively; hide gh binary during git ops.
# ============================================================

export GITHUB_TOKEN="$GH_TOKEN"

# Get user info via curl (NOT gh api — avoids triggering credential helper)
GH_USER_JSON=$(curl -sf -H "Authorization: token ${GH_TOKEN}" https://api.github.com/user 2>/dev/null \
    | jq '{name: .name, login: .login, email: .email, id: .id}' 2>/dev/null || echo '{}')
GH_USER_NAME=$(echo "$GH_USER_JSON" | jq -r '.name // .login // empty')
GH_USER_EMAIL=$(echo "$GH_USER_JSON" | jq -r '.email // empty')

if [ -z "$GH_USER_NAME" ]; then GH_USER_NAME="masterbot"; fi
if [ -z "$GH_USER_EMAIL" ]; then GH_USER_EMAIL="masterbot@users.noreply.github.com"; fi

git config --global user.name "$GH_USER_NAME"
git config --global user.email "$GH_USER_EMAIL"

# Hide gh from git: temporarily rename the binary so git can't invoke it as a credential helper
GH_PATH=$(which gh 2>/dev/null || true)
if [ -n "$GH_PATH" ]; then
    mv "$GH_PATH" "${GH_PATH}.bak"
fi

# Nuke every possible credential helper config
git config --global --unset-all credential.helper 2>/dev/null || true
git config --system --unset-all credential.helper 2>/dev/null || true
echo "" > /etc/gitconfig 2>/dev/null || true
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1
export GIT_ASKPASS=""

# Build authenticated URL (embed token directly)
AUTH_URL=$(echo "$REPO_URL" | sed "s|https://github.com/|https://x-access-token:${GH_TOKEN}@github.com/|")

# Clone the feat branch
if [ -n "$REPO_URL" ]; then
    echo "Cloning: $REPO_URL branch: $BRANCH"
    git clone --single-branch --branch "$BRANCH" --depth 1 "$AUTH_URL" /job
else
    echo "No REPO_URL provided"
    exit 1
fi

# Restore gh binary (needed later for gh pr operations)
if [ -n "$GH_PATH" ] && [ -f "${GH_PATH}.bak" ]; then
    mv "${GH_PATH}.bak" "$GH_PATH"
fi

cd /job

# Create temp directory for agent use (gitignored)
mkdir -p /job/tmp

# Symlink pi-skills into .pi/skills/ so Pi discovers them
mkdir -p /job/.pi/skills
ln -sf /pi-skills/brave-search /job/.pi/skills/brave-search

# Setup log directory
LOG_DIR="/job/logs/${FEAT_ID}"
mkdir -p "${LOG_DIR}"

# Build system prompt from operating_system/ MD files
mkdir -p /job/.pi
SYSTEM_FILES=("SOUL.md" "AGENT.md")
> /job/.pi/SYSTEM.md
for i in "${!SYSTEM_FILES[@]}"; do
    SRC="/job/operating_system/${SYSTEM_FILES[$i]}"
    if [ -f "$SRC" ]; then
        cat "$SRC" >> /job/.pi/SYSTEM.md
        if [ "$i" -lt $((${#SYSTEM_FILES[@]} - 1)) ]; then
            echo -e "\n\n" >> /job/.pi/SYSTEM.md
        fi
    fi
done

# Read the job description
JOB_FILE="${LOG_DIR}/job.md"
if [ ! -f "$JOB_FILE" ]; then
    echo "ERROR: job.md not found at ${JOB_FILE}"
    exit 1
fi

PROMPT="

# Your Job

$(cat "${JOB_FILE}")"

# Determine model flags — OpenRouter is the default provider
MODEL_FLAGS=""
if [ -n "$MODEL" ]; then
    if [ -n "$OPENROUTER_API_KEY" ]; then
        MODEL_FLAGS="--provider openrouter --model $MODEL"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        MODEL_FLAGS="--provider anthropic --model $MODEL"
    fi
elif [ -n "$OPENROUTER_API_KEY" ]; then
    # Default: use OpenRouter with the configured model
    DEFAULT_MODEL="${DEFAULT_AGENT_MODEL:-openai/gpt-4o}"
    MODEL_FLAGS="--provider openrouter --model $DEFAULT_MODEL"
fi

echo "Running Pi agent with flags: $MODEL_FLAGS"
pi $MODEL_FLAGS -p "$PROMPT" --session-dir "${LOG_DIR}"

# Commit changes + logs
git add -A
git add -f "${LOG_DIR}"
git commit -m "masterbot: feat ${FEAT_ID}" || echo "Nothing to commit"

# Ensure remote URL has token embedded, then hide gh again for push
if [ -n "$GH_PATH" ]; then mv "$GH_PATH" "${GH_PATH}.bak"; fi
AUTH_PUSH_URL=$(git remote get-url origin 2>/dev/null)
if ! echo "$AUTH_PUSH_URL" | grep -q "x-access-token"; then
    git remote set-url origin "$AUTH_URL"
fi
git push origin
if [ -n "$GH_PATH" ] && [ -f "${GH_PATH}.bak" ]; then mv "${GH_PATH}.bak" "$GH_PATH"; fi

# Open PR from feat branch → project-dev (agent opens it after code is committed)
# Parse project metadata from job.md header comment
META_LINE=$(grep -m1 'masterbot-meta' "${JOB_FILE}" 2>/dev/null || echo "")
PROJECT=$(echo "$META_LINE" | sed 's/.*project="\([^"]*\)".*/\1/')
DEV_BRANCH=$(echo "$META_LINE" | sed 's/.*dev_branch="\([^"]*\)".*/\1/')
if [ -z "$PROJECT" ]; then PROJECT="${FEAT_ID%%-*}"; fi
if [ -z "$DEV_BRANCH" ]; then DEV_BRANCH="${PROJECT}-dev"; fi
REPO_FULL=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\.git$||')

# Read task title from job.md (first non-empty, non-comment line)
TASK_TITLE=$(grep -v '^<!--' "${JOB_FILE}" 2>/dev/null | grep -m1 '.' | sed 's/^#* *//' | head -c 80 || echo "feat ${FEAT_ID}")

# Check if PR already exists
EXISTING_PR=$(gh pr list \
    --head "$BRANCH" \
    --base "$DEV_BRANCH" \
    --repo "$REPO_FULL" \
    --state open \
    --json number \
    -q '.[0].number' 2>/dev/null || echo "")

if [ -z "$EXISTING_PR" ]; then
    PR_BODY=$(printf "## Task\n\n%s\n\n**Feat ID:** \`%s\`\n\n_Generated by masterbot Pi coding agent_" \
        "$(cat "${JOB_FILE}" 2>/dev/null | head -30)" "$FEAT_ID")
    gh pr create \
        --title "feat: ${TASK_TITLE}" \
        --body "$PR_BODY" \
        --head "$BRANCH" \
        --base "$DEV_BRANCH" \
        --repo "$REPO_FULL" \
        --label "automated" \
        2>/dev/null || echo "PR creation skipped (may already exist or labels missing)"
    echo "PR created: feat/${FEAT_ID} → ${DEV_BRANCH}"
else
    echo "PR #${EXISTING_PR} already exists for ${BRANCH}"
fi

# Cleanup
if [ -n "$CHROME_PID" ]; then kill $CHROME_PID 2>/dev/null || true; fi
echo "Done. Feat ID: ${FEAT_ID}"
