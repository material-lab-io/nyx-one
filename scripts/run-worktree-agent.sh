#!/usr/bin/env bash
# run-worktree-agent.sh — Ralph loop: headless Claude agent in a git worktree
#
# Usage: scripts/run-worktree-agent.sh <worktree-name> <branch-name> [max-iterations]
#
# The agent reads WORKTREE_TASK.md for instructions and PROGRESS.md for state.
# Each iteration: fresh context, does one task, commits, updates PROGRESS.md.
# Loop exits on .ralph-complete, max iterations (default 20), or 3 consecutive stalls.

set -euo pipefail

WORKTREE_NAME="${1:?Usage: $0 <worktree-name> <branch-name> [max-iterations]}"
BRANCH_NAME="${2:?Usage: $0 <worktree-name> <branch-name> [max-iterations]}"
MAX_ITERATIONS="${3:-20}"

MAIN_REPO="/home/kanaba/nyx-one"
WORKTREE_DIR="/home/kanaba/${WORKTREE_NAME}"

echo "=== Ralph Loop ==="
echo "Worktree: ${WORKTREE_DIR}"
echo "Branch:   ${BRANCH_NAME}"
echo "Max iter: ${MAX_ITERATIONS}"
echo ""

# --- Create worktree if it doesn't exist ---
if [ ! -d "${WORKTREE_DIR}" ]; then
    echo "Creating worktree..."
    cd "${MAIN_REPO}"
    git worktree add -b "${BRANCH_NAME}" "${WORKTREE_DIR}" main
    echo "Worktree created at ${WORKTREE_DIR}"
else
    echo "Worktree already exists at ${WORKTREE_DIR}"
fi

# --- Verify WORKTREE_TASK.md exists ---
if [ ! -f "${WORKTREE_DIR}/WORKTREE_TASK.md" ]; then
    echo "ERROR: ${WORKTREE_DIR}/WORKTREE_TASK.md not found."
    echo "Write the task file before running this script."
    exit 1
fi

# --- Initialize PROGRESS.md if missing ---
if [ ! -f "${WORKTREE_DIR}/PROGRESS.md" ]; then
    cat > "${WORKTREE_DIR}/PROGRESS.md" << 'EOF'
# Progress

## Status: NOT_STARTED

## Completed Steps
(none yet)

## Next Step
Read WORKTREE_TASK.md and begin work.

## Notes
(none)
EOF
    echo "Initialized PROGRESS.md"
fi

# --- Ralph Loop ---
cd "${WORKTREE_DIR}"
stall_count=0
prev_hash=""

for i in $(seq 1 "${MAX_ITERATIONS}"); do
    echo ""
    echo "========== Iteration ${i}/${MAX_ITERATIONS} =========="

    # Check for completion signal
    if [ -f "${WORKTREE_DIR}/.ralph-complete" ]; then
        echo "Found .ralph-complete — exiting loop."
        break
    fi

    # Run headless Claude
    claude --dangerously-skip-permissions -p "$(cat <<'PROMPT'
You are Ralph, a headless coding agent working in a git worktree.

## Your workflow each iteration:
1. Read PROGRESS.md to understand current state
2. Read WORKTREE_TASK.md for the full task list
3. Do ONE meaningful task (the "Next Step" from PROGRESS.md)
4. Run tests to verify your changes work
5. Stage and commit your changes with a descriptive message
6. Update PROGRESS.md with what you completed and what's next
7. If ALL tasks are done and tests pass, create a file called .ralph-complete

## Rules:
- Run tests after each change if applicable
- Make small, focused commits
- If stuck on something, note it in PROGRESS.md and move to the next task
- NEVER skip tests — if they fail, fix them before moving on
- Update PROGRESS.md even if you couldn't complete the step (note why)
PROMPT
)" 2>&1 | tee "/tmp/ralph-${WORKTREE_NAME}-iter${i}.log"

    # Detect stalls (no new commits)
    current_hash=$(git rev-parse HEAD 2>/dev/null || echo "none")
    if [ "${current_hash}" = "${prev_hash}" ]; then
        stall_count=$((stall_count + 1))
        echo "Stall detected (${stall_count}/3)"
        if [ "${stall_count}" -ge 3 ]; then
            echo "3 consecutive stalls — exiting loop."
            break
        fi
    else
        stall_count=0
    fi
    prev_hash="${current_hash}"
done

echo ""
echo "=== Ralph Loop Complete ==="
echo "Worktree: ${WORKTREE_DIR}"
echo "Final commit: $(git log --oneline -1)"
echo ""
if [ -f "${WORKTREE_DIR}/.ralph-complete" ]; then
    echo "Status: COMPLETED"
else
    echo "Status: STOPPED (check PROGRESS.md for details)"
fi
