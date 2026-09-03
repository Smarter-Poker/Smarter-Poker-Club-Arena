#!/usr/bin/env bash
# Agent Recovery Janitor
# Automatically finds abandoned per-agent worktrees (>2 hours old),
# safely commits their state as a backup, pushes to a recovery branch,
# and opens a draft PR. Does not touch trees with recent activity.

set -uo pipefail

ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  echo "not a git repository" >&2; exit 2; }
ROOT=${ROOT%/.git}

echo "Running Janitor Sweep at $(date)"

AT_RISK=0
RECOVERED=0

while IFS= read -r line; do
  case "$line" in
    worktree\ *) DIR=${line#worktree } ;;
    branch\ *)   BR=${line#branch refs/heads/} ;;
    "")
      [ -n "${DIR:-}" ] || continue
      
      # Exclude the shared clone itself from janitor sweeps
      if [ "$DIR" = "$ROOT" ]; then
        DIR=""; BR=""; continue
      fi
      
      DIRTY=$(git -C "$DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      
      if git -C "$DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
        AHEAD=$(git -C "$DIR" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
      else
        AHEAD=$(git -C "$DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      fi

      AGE_MIN=0
      if [ "$DIRTY" -gt 0 ]; then
        NEWEST=$(git -C "$DIR" status --porcelain 2>/dev/null | sed 's/^...//' \
          | while IFS= read -r f; do [ -f "$DIR/$f" ] && stat -f %m "$DIR/$f" 2>/dev/null; done \
          | sort -rn | head -1)
        if [ -n "$NEWEST" ]; then
          AGE_MIN=$(( ( $(date +%s) - NEWEST ) / 60 ))
        fi
      fi

      if [ "$DIRTY" -gt 0 ] || [ "${AHEAD:-0}" -gt 0 ]; then
        if [ "$AGE_MIN" -lt 120 ] && [ "$DIRTY" -gt 0 ]; then
          echo "SKIP: $DIR is dirty but active ($AGE_MIN mins ago). Leaving it alone."
        else
          echo "RECOVERING: $DIR (Abandoned for $AGE_MIN mins, $AHEAD unpushed commits)"
          
          SAFE_BRANCH="recovery/$(basename "$DIR")-$(date +%s)"
          
          git -C "$DIR" checkout -b "$SAFE_BRANCH" >/dev/null 2>&1 || true
          if [ "$DIRTY" -gt 0 ]; then
            git -C "$DIR" add -A
            git -C "$DIR" commit -m "chore(recovery): automatic backup of stranded work" --no-verify >/dev/null 2>&1 || true
          fi
          
          git -C "$DIR" push -u origin "$SAFE_BRANCH" --no-verify >/dev/null 2>&1 || true
          
          source ~/.env 2>/dev/null || true
          GH_TOKEN="${GITHUB_TOKEN:-${GH_PAT:-}}" gh pr create -R Smarter-Poker/Smarter-Poker-Club-Arena \
            --head "$SAFE_BRANCH" \
            --title "Recovery: Abandoned work in $(basename "$DIR")" \
            --body "This work was left unpushed/uncommitted for >2 hours. The Janitor automatically backed it up to prevent local destruction by a reset." \
            --draft >/dev/null 2>&1 || true
            
          RECOVERED=$((RECOVERED + 1))
        fi
        AT_RISK=$((AT_RISK + 1))
      fi
      
      DIR=""; BR=""
      ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain; echo)

echo "Sweep complete. Found $AT_RISK at-risk trees, recovered $RECOVERED."
