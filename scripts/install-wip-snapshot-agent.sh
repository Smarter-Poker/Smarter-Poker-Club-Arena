#!/usr/bin/env bash
# RUN THE SNAPSHOT ON A TIMER, SO NOBODY HAS TO REMEMBER.
#
# .husky/reference-transaction now makes it impossible for a reset to orphan a
# local COMMIT. That leaves the other half: work that has not been committed at
# all. `git reset --hard` discards tracked modifications outright, and an agent
# mid-edit has no warning and no reflog entry to recover from.
#
# scripts/agent-trees-snapshot.sh captures that state without touching anything.
# This installs it as a launchd agent so it runs every ten minutes across every
# repo on this machine. Worst case you lose ten minutes; today you lose the
# session.
#
#   bash scripts/install-wip-snapshot-agent.sh            # install + start
#   bash scripts/install-wip-snapshot-agent.sh --status   # is it running
#   bash scripts/install-wip-snapshot-agent.sh --uninstall
#
# It is deliberately a launchd agent and not an Open Claw job or a GitHub
# Actions schedule: it reads working trees that exist only on this Mac, and the
# repo rules (World Hub CLAUDE.md section 11) reserve those schedulers for
# application logic. This is a developer-machine safety net.
set -uo pipefail

LABEL="poker.agent-wip-snapshot"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/${LABEL}.log"
INTERVAL="${WIP_SNAPSHOT_INTERVAL:-600}"

case "${1:-install}" in
  --status)
    launchctl list | grep -q "$LABEL" && echo "running (every ${INTERVAL}s)" || echo "NOT installed"
    echo "plist: $PLIST"
    echo "log:   $LOG"
    RL="$HOME/Library/Application Support/poker-agent-wip-repos.txt"
    if [ -s "$RL" ]; then
      echo "repos: $(wc -l < "$RL" | tr -d ' ') listed in $RL"
    else
      echo "repos: LIST MISSING OR EMPTY ($RL) — this guard is capturing nothing"
    fi
    if [ -f "$LOG" ] && tail -60 "$LOG" | grep -q 'not a git repository'; then
      echo "STATE: INSTALLED BUT CAPTURING NOTHING — macOS TCC is blocking reads of"
      echo "       ~/Documents. Grant Full Disk Access to /bin/bash and re-install."
    elif [ -f "$LOG" ] && tail -60 "$LOG" | grep -q 'captured\|nothing to capture'; then
      echo "STATE: working — the agent can read the repos"
    fi
    [ -f "$LOG" ] && { echo "--- last 20 log lines ---"; tail -20 "$LOG"; }
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled. Existing refs/wip/* snapshots are untouched."
    exit 0 ;;
esac

# ── HOW A REPO QUALIFIES ────────────────────────────────────────────────────
#
# 2026-08-22: THIS GUARD HAD BEEN DOING NOTHING FOR 73 CONSECUTIVE RUNS.
#
# Two independent faults, and each one alone was enough.
#
# FAULT 1 — discovery asked the working tree.
#   `[ -f "$repo/scripts/agent-trees-snapshot.sh" ] || continue`, described as
#   "covered the moment it carries the script". It asks the WORKING TREE, which
#   is precisely the thing that goes stale. The shared Club Arena clone sat 160
#   commits behind origin/main, from before the script existed. Nor was the file
#   in any of the other 25 clones under ~/Documents. Zero repos matched.
#   FIXED by copying the script next to the runner at install time, so a stale
#   checkout can no longer switch the safety net off.
#
# FAULT 2 — macOS TCC. THIS ONE WOULD HAVE SURVIVED FIXING THE FIRST.
#   ~/Documents is a TCC-protected folder. An unprivileged launchd agent may
#   not ENUMERATE it. Measured, same script, same $HOME, same uid:
#
#       shell:    ls ~/Documents -> rc 0,  `~/Documents/*/` matched 40
#       launchd:  ls ~/Documents -> "Operation not permitted",  matched 1
#                 (the unexpanded pattern)
#
#   So `for repo in "$HOME"/Documents/*/` iterates NOTHING under launchd, for
#   every repo, forever. Note the asymmetry that makes the fix possible:
#   stat-ing a KNOWN path inside the folder still works —
#   `[ -d ~/Documents/Smarter-Poker-Club-Arena/.git ]` was true under launchd
#   in the same probe. TCC protects the listing, not the paths.
#   FIXED by resolving the repo list HERE, at install time, in a shell that has
#   TCC access, and writing it to a file the runner reads. The runner never
#   globs a protected directory.
#
# AND THE REASON NOBODY NOTICED: the runner only printed when a repo produced
# output. A log of bare timestamps read exactly like "all quiet". It meant
# "I did not look anywhere." The runner now reports every repo and prints the
# count, so silence can never again be mistaken for nothing-to-do.
RUNNER="$HOME/Library/Application Support/poker-agent-wip-snapshot.sh"
CANON="$HOME/Library/Application Support/poker-agent-trees-snapshot.sh"
REPOLIST="$HOME/Library/Application Support/poker-agent-wip-repos.txt"
mkdir -p "$(dirname "$RUNNER")"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-trees-snapshot.sh"
if [ ! -f "$SRC" ]; then
  echo "cannot find agent-trees-snapshot.sh next to this installer" >&2
  exit 2
fi
cp "$SRC" "$CANON"
chmod +x "$CANON"

# Resolved here, where the glob works. Re-run this installer after cloning a
# new repo; --status prints the list so a gap is visible rather than silent.
: > "$REPOLIST"
for repo in "$HOME"/Documents/*/; do
  [ -d "$repo/.git" ] || continue
  printf '%s\n' "${repo%/}" >> "$REPOLIST"
done
LISTED=$(wc -l < "$REPOLIST" | tr -d ' ')
if [ "$LISTED" -eq 0 ]; then
  echo "WARNING: found no git repositories under ~/Documents. Installing anyway," >&2
  echo "         but this guard will capture nothing until the list is populated." >&2
fi

cat > "$RUNNER" <<RUN
#!/usr/bin/env bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
CANON="${CANON}"
REPOLIST="${REPOLIST}"
RUN
cat >> "$RUNNER" <<'RUN'
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if [ ! -s "$REPOLIST" ]; then
  echo "  WARNING: repo list is missing or empty ($REPOLIST)."
  echo "           Re-run scripts/install-wip-snapshot-agent.sh from a shell."
  exit 0
fi

EXAMINED=0; CAPTURED=0; SKIPPED=0
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  NAME=$(basename "$repo")
  # A known path inside a TCC-protected folder is still stat-able; only the
  # listing is blocked. This is why the list exists.
  if [ ! -d "$repo/.git" ]; then
    printf '  %-32s GONE or unreadable — not being captured
' "$NAME"; SKIPPED=$((SKIPPED+1)); continue
  fi
  EXAMINED=$((EXAMINED+1))

  # THE CANONICAL COPY WINS. Corrected 2026-08-26; this used to prefer
  # "$repo/scripts/agent-trees-snapshot.sh" and fall back to $CANON.
  #
  # Why that was backwards: the per-repo copy is whatever the clone's CURRENT
  # BRANCH happens to hold, and these clones are routinely parked on a feature
  # branch (club-arena sat on agent-rescue/uncommitted-migrations, the World Hub
  # on fix/avatar-layout-fix). A fix merged to main therefore did not reach the
  # running snapshotter at all. On 2026-08-26 the dedupe fix was merged in four
  # repos and every launchd run still executed the old script, quietly writing a
  # fresh ref per worktree every ten minutes - the exact bug the merge closed.
  #
  # $CANON is refreshed by this installer and lives outside any working tree, so
  # nothing can revert it. The per-repo copy stays as the fallback for a repo
  # that was never installed from.
  SCRIPT="$CANON"
  [ -f "$SCRIPT" ] || SCRIPT="$repo/scripts/agent-trees-snapshot.sh"

  OUT=$(cd "$repo" && bash "$SCRIPT" 2>&1)
  case "$OUT" in
    *"nothing to capture"*)   printf '  %-32s nothing to capture
' "$NAME" ;;
    *"not a git repository"*) printf '  %-32s not a git repository
' "$NAME" ;;
    *captured*)
      N=$(printf '%s' "$OUT" | grep -c '^captured')
      CAPTURED=$((CAPTURED+N))
      printf '  %-32s %s captured
' "$NAME" "$N"
      printf '%s
' "$OUT" | grep '^captured' | sed 's/^/      /' ;;
    *) printf '  %-32s UNEXPECTED:
' "$NAME"; printf '%s
' "$OUT" | sed 's/^/      /' ;;
  esac
  (cd "$repo" && bash "$SCRIPT" --prune >/dev/null 2>&1) || true
done < "$REPOLIST"

# The failure this replaced looked identical to success. Always say the number.
echo "  --- $EXAMINED repo(s) examined, $CAPTURED snapshot(s) taken, $SKIPPED unreadable ---"
if [ "$EXAMINED" -eq 0 ]; then
  echo "  WARNING: no repository in the list could be read. This guard is doing nothing."
fi
RUN
chmod +x "$RUNNER"

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${RUNNER}</string></array>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "installed: ${LABEL}, every ${INTERVAL}s, log at ${LOG}"
echo "repos:     ${LISTED} listed in ${REPOLIST}"

# ── PROVE IT CAN ACTUALLY READ THEM ─────────────────────────────────────────
#
# "installed" is a status code. Whether the agent can read a repo is the
# outcome, and for twelve hours those two disagreed while the log looked calm.
#
# macOS TCC protects ~/Documents. A launchd agent may stat a known path inside
# it but may not open one. Measured on this machine, same script, same $HOME,
# same uid:
#
#     shell:    cat ~/Documents/<repo>/.git/HEAD  ->  ref: refs/heads/main
#     launchd:  cat ~/Documents/<repo>/.git/HEAD  ->  Operation not permitted
#
# `[ -d "$repo/.git" ]` is true in BOTH, which is why nothing looked wrong.
# The one repo that did work is a symlink whose realpath is outside
# ~/Documents — the folder is the boundary, not the path.
#
# So the install is not finished until the agent has demonstrably read one.
sleep 3
# Read ONLY the most recent run block, and require that NOT ONE repo came back
# unreadable. An earlier version of this check accepted "any repo worked" and
# passed on a single symlinked repo whose real path is outside ~/Documents
# while the other 25 were blocked — the same false green this whole fix exists
# to remove.
PROBE_OK=0
if [ -s "$LOG" ]; then
  LAST_RUN=$(awk '/^=== /{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$LOG")
  BLOCKED_N=$(printf '%s' "$LAST_RUN" | grep -c 'not a git repository' || true)
  SAW_WORK=$(printf '%s' "$LAST_RUN" | grep -c 'captured\|nothing to capture' || true)
  if [ "${BLOCKED_N:-1}" -eq 0 ] && [ "${SAW_WORK:-0}" -gt 0 ]; then PROBE_OK=1; fi
fi

if [ "$PROBE_OK" -eq 1 ]; then
  echo "verified:  the agent can read the repos (see ${LOG})"
else
  cat <<'BLOCKED'

  ────────────────────────────────────────────────────────────────────────
  INSTALLED BUT NOT WORKING — the agent cannot read the repositories.

  Every repo will report "not a git repository" in the log. That is macOS
  TCC: ~/Documents is protected, and an unprivileged launchd agent may stat
  a path inside it but not open one. Nothing in this repo can grant that.

  ONE-TIME FIX, by a human, once per machine:
    System Settings -> Privacy & Security -> Full Disk Access -> +
    add  /bin/bash   (or /opt/homebrew/bin/bash if that is the login shell)
    then:  bash scripts/install-wip-snapshot-agent.sh

  UNTIL THAT IS DONE, THE TEN-MINUTE SNAPSHOT CAPTURES NOTHING.
  The script itself is unaffected and works perfectly from a shell — run it
  by hand at the start and end of a session:

    bash scripts/agent-trees-snapshot.sh
    bash scripts/agent-trees-snapshot.sh --list

  AGENT-PLAYBOOK.md section 3 promises this runs every ten minutes. Until
  the grant exists, that promise is only true for repos whose real path is
  outside ~/Documents.
  ────────────────────────────────────────────────────────────────────────
BLOCKED
fi
echo "check it with: bash scripts/install-wip-snapshot-agent.sh --status"
