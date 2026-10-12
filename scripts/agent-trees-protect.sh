#!/usr/bin/env bash
# A COPY OF EVERYTHING ONE `git reset --hard` AWAY FROM GONE (2026-10-01).
#
# scripts/agent-trees-audit.sh is the look: it names every worktree holding
# uncommitted edits or commits no remote has. This is the copy. For each such
# tree it writes, into one dated folder outside every tree:
#
#   <name>.bundle          the commits no remote branch has (git bundle; in any
#                          clone, `git fetch <file> HEAD:refs/heads/recovered/<name>`)
#   <name>.patch           tracked edits, staged and unstaged (`git apply` it)
#   <name>.untracked.tgz   untracked files, each under 5 MB, ignoring
#                          node_modules, dist and anything .gitignore excludes
#   manifest.tsv           one line per tree: path, branch, HEAD, counts, files
#
# READ-ONLY TO EVERY TREE. It never commits, stashes, checks out, resets,
# pushes or deletes, and it touches no tree's index: a bundle and a diff only
# read objects. Nothing leaves this Mac; pushing another agent's branch would
# open pull requests in its name. Run it by hand; it schedules nothing.
#
#   bash scripts/agent-trees-protect.sh <outDir> [--skip-prefix <path>]...
#
# --skip-prefix leaves out trees that are already an archive (for example
# /Volumes/SmarterArchives), which are the copy, not the risk.

set -uo pipefail

OUT=${1:-}
[ -n "$OUT" ] || { echo "usage: $0 <outDir> [--skip-prefix <path>]..." >&2; exit 2; }
shift
SKIP=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-prefix) SKIP+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  echo "not a git repository" >&2; exit 2; }
ROOT=${ROOT%/.git}

mkdir -p "$OUT" || exit 2
MANIFEST="$OUT/manifest.tsv"
printf 'tree\tbranch\thead\tunpushed\tuncommitted\tuntracked\tfiles\n' > "$MANIFEST"
COPIED=0
FAILED=0

protect() {
  local dir=$1 br=$2
  local name
  name=$(printf '%s' "$dir" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g')
  local head unpushed dirty untracked files=""
  head=$(git -C "$dir" rev-parse --short=12 HEAD 2>/dev/null) || { FAILED=$((FAILED + 1)); return; }
  unpushed=$(git -C "$dir" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
  dirty=$(git -C "$dir" diff HEAD --name-only 2>/dev/null | wc -l | tr -d ' ')
  untracked=$(git -C "$dir" ls-files --others --exclude-standard 2>/dev/null \
    | grep -vE '(^|/)(node_modules|dist|dist-native)(/|$)' | wc -l | tr -d ' ')
  [ "$unpushed" -gt 0 ] || [ "$dirty" -gt 0 ] || [ "$untracked" -gt 0 ] || return

  if [ "$unpushed" -gt 0 ]; then
    if git -C "$dir" bundle create "$OUT/$name.bundle" HEAD --not --remotes >/dev/null 2>&1 \
      && git -C "$dir" bundle verify "$OUT/$name.bundle" >/dev/null 2>&1; then
      files="$name.bundle"
    else
      echo "FAILED bundle: $dir" >&2; FAILED=$((FAILED + 1))
    fi
  fi
  if [ "$dirty" -gt 0 ]; then
    git -C "$dir" diff --binary HEAD > "$OUT/$name.patch" 2>/dev/null \
      && files="${files:+$files,}$name.patch" \
      || { echo "FAILED patch: $dir" >&2; FAILED=$((FAILED + 1)); }
  fi
  if [ "$untracked" -gt 0 ]; then
    local list="$OUT/$name.untracked.txt"
    git -C "$dir" ls-files --others --exclude-standard -z 2>/dev/null \
      | tr '\0' '\n' | grep -vE '(^|/)(node_modules|dist|dist-native)(/|$)' \
      | while IFS= read -r f; do
          [ -f "$dir/$f" ] && [ "$(wc -c < "$dir/$f" | tr -d ' ')" -lt 5242880 ] && printf '%s\n' "$f"
        done > "$list"
    if [ -s "$list" ]; then
      tar -czf "$OUT/$name.untracked.tgz" -C "$dir" -T "$list" 2>/dev/null \
        && files="${files:+$files,}$name.untracked.tgz" \
        || { echo "FAILED untracked: $dir" >&2; FAILED=$((FAILED + 1)); }
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$dir" "$br" "$head" "$unpushed" "$dirty" "$untracked" "$files" >> "$MANIFEST"
  COPIED=$((COPIED + 1))
  echo "copied  $dir  ($unpushed unpushed, $dirty edited, $untracked untracked)"
}

DIR=""; BR=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *) DIR=${line#worktree } ;;
    branch\ *)   BR=${line#branch refs/heads/} ;;
    "")
      if [ -n "$DIR" ] && [ -d "$DIR" ]; then
        skip=0
        for p in "${SKIP[@]+"${SKIP[@]}"}"; do case "$DIR" in "$p"*) skip=1 ;; esac; done
        [ "$skip" = 0 ] && protect "$DIR" "${BR:-detached}"
      fi
      DIR=""; BR=""
      ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain; echo)

echo "$COPIED tree(s) copied to $OUT, $FAILED failure(s). Manifest: $MANIFEST"
[ "$FAILED" -eq 0 ]
