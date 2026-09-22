#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# THE ORIGIN-OWNED ACTIVATION TRANSACTION.
#
# publish-club-arena.yml pipes this file to the origin over ssh as
#   ssh ... bash -s -- "$ORIGIN_ROOT" "$SHA" "$EXPECTED_SHA" "$STAGE_NAME" ...
# and the publishing job checks the repository out at the exact SHA it is
# publishing, so the transaction that activates a release is always the one
# that release carries.
#
# IT LIVES IN A FILE BECAUSE A STEP MAY NOT EXCEED 21,000 CHARACTERS
# (2026-09-22). GitHub documents that limit on jobs.<job_id>.steps[*].run,
# and this transaction inlined as a heredoc took the step to 24,626. Over
# the limit GitHub does not run the step and does not fail it: it refuses to
# LOAD THE WHOLE WORKFLOW, names the run after the file path instead of
# "Publish Club Arena", creates that failed run even for pushes to branches
# the triggers exclude, and answers a repository_dispatch with no run at
# all. Production sat on one bundle for over an hour and no publish reached
# it. tests/a-workflow-step-fits-what-github-will-run.law.test.ts measures
# every step in the repository so it cannot happen again.
#
# Every guard here still says what it refused; the same law that reads the
# workflow reads this file (tests/the-publisher-says-what-it-refused.law.test.ts).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
ROOT="$1"
SHA="$2"
EXPECTED_SHA="$3"
STAGE_NAME="$4"
KEEP_RELEASES="$5"
REPOSITORY="$6"
[ "$ROOT" = /srv/club-arena ] \
  || { echo "the origin root this transaction was handed is '$ROOT', not /srv/club-arena; refusing to touch it" >&2; exit 1; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "the candidate handed to the origin is not one full lowercase SHA: '$SHA'" >&2; exit 1; }
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "the release the origin was told it serves is not one full lowercase SHA: '$EXPECTED_SHA'" >&2; exit 1; }
[[ "$STAGE_NAME" =~ ^${SHA}\.[0-9]+\.[0-9]+$ ]] \
  || { echo "the staging name '$STAGE_NAME' does not belong to candidate $SHA; refusing to activate another invocation's bytes" >&2; exit 1; }
[[ "$KEEP_RELEASES" =~ ^[1-9][0-9]*$ ]] \
  || { echo "the retention count is '$KEEP_RELEASES', not a positive integer; refusing to prune releases by an unknown rule" >&2; exit 1; }
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || { echo "the repository name '$REPOSITORY' is not owner/name; release identity cannot be checked against it" >&2; exit 1; }
for REQUIRED_TOOL in flock python3 rsync sha256sum sync; do
  command -v "$REQUIRED_TOOL" >/dev/null \
    || { echo "the origin host has no $REQUIRED_TOOL on PATH; this transaction needs it to publish safely" >&2; exit 1; }
done

STAGE="$ROOT/incoming/$STAGE_NAME"
FINAL="$ROOT/releases/$SHA"
NEXT="$ROOT/.current.$STAGE_NAME"
CHECK="$ROOT/incoming/.manifest-check.$STAGE_NAME"
LEGACY_MANIFEST="$ROOT/incoming/.legacy-release-manifest.$STAGE_NAME"
FONT_NEXT="$ROOT/pool/fonts/.fonts.css.$STAGE_NAME"
for DIRECTORY in "$ROOT" "$ROOT/incoming" "$ROOT/releases" "$ROOT/pool" "$ROOT/pool/assets" "$ROOT/pool/fonts"; do
  [ -d "$DIRECTORY" ] \
    || { echo "origin layout: $DIRECTORY is not a directory; found: $(ls -ld -- "$DIRECTORY" 2>&1 || true)" >&2; exit 1; }
  [ ! -L "$DIRECTORY" ] \
    || { echo "origin layout: $DIRECTORY is a symlink to $(readlink "$DIRECTORY"); refusing a root that can escape itself" >&2; exit 1; }
done
[ ! -L "$ROOT/.publish.lock" ] \
  || { echo "the publish lock $ROOT/.publish.lock is a symlink to $(readlink "$ROOT/.publish.lock"); refusing to serialize against a file somebody else chose" >&2; exit 1; }
for TEMPORARY in "$NEXT" "$CHECK" "$LEGACY_MANIFEST" "$FONT_NEXT"; do
  [ ! -e "$TEMPORARY" ] && [ ! -L "$TEMPORARY" ] \
    || { echo "this transaction's scratch path $TEMPORARY already exists; found: $(ls -ld -- "$TEMPORARY" 2>&1 || true)" >&2; exit 1; }
done
trap 'rm -f -- "$NEXT" "$CHECK" "$LEGACY_MANIFEST" "$FONT_NEXT"' EXIT
exec 9>"$ROOT/.publish.lock"
flock -w 45 9 \
  || { echo "another publish held $ROOT/.publish.lock for the whole 45s activation window; this candidate was not activated and nothing was changed" >&2; exit 1; }

read_exact_build_info_sha() {
  local build_info_path="$1"
  python3 - "$build_info_path" <<'PYTHON_BUILD_INFO'
import json
import re
import sys

try:
    with open(sys.argv[1], encoding='utf-8') as handle:
        build_info = json.load(handle)
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit(f'build-info is absent or malformed: {error}')
if type(build_info) is not dict:
    raise SystemExit('build-info must be one JSON object')
sha = build_info.get('ca_sha')
if type(sha) is not str or re.fullmatch(r'[0-9a-f]{40}', sha) is None:
    raise SystemExit('build-info has no full lowercase ca_sha')
print(sha)
PYTHON_BUILD_INFO
}

verify_release_identity() {
  local release_dir="$1"
  local expected_sha="$2"
  local repository="$3"
  python3 - \
    "$release_dir/ca-provenance.json" \
    "$release_dir/build-info.json" \
    "$expected_sha" \
    "$repository" <<'PYTHON_RELEASE_IDENTITY'
import json
import re
import sys

provenance_path, build_info_path, expected_sha, repository = sys.argv[1:]
try:
    with open(provenance_path, encoding='utf-8') as handle:
        provenance = json.load(handle)
    with open(build_info_path, encoding='utf-8') as handle:
        build_info = json.load(handle)
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit(f'release identity is absent or malformed: {error}')

def require(condition, message):
    if not condition:
        raise SystemExit(message)

require(type(provenance) is dict, 'release provenance is not one JSON object')
require(type(build_info) is dict, 'release build-info is not one JSON object')
require(type(provenance.get('schema')) is int and provenance['schema'] == 1,
        'release provenance schema is invalid')
require('validationOnly' not in provenance or provenance['validationOnly'] is False,
        'CI validation bundles cannot be published')
require(provenance.get('commit') == expected_sha,
        'release provenance does not match its source SHA')
require(provenance.get('builtBy') == 'github-actions',
        'release was not built by GitHub Actions')
require(provenance.get('dirty') is False,
        'release provenance is dirty')
require(provenance.get('historyComplete') is True,
        'release provenance has incomplete history')
require(type(provenance.get('behindMain')) is int and provenance['behindMain'] == 0,
        'release provenance was behind protected main')
require(type(provenance.get('aheadMain')) is int and provenance['aheadMain'] == 0,
        'release provenance was ahead of protected main')
require(build_info.get('ca_sha') == expected_sha,
        'release build-info does not match its source SHA')
require(build_info.get('built_by') == 'publish-club-arena.yml',
        'release build-info names the wrong publisher')
require(type(build_info.get('built_at')) is str and
        re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', build_info['built_at']) is not None,
        'release build-info has no UTC build time')
require(type(build_info.get('run_id')) is str and
        re.fullmatch(r'[0-9]+', build_info['run_id']) is not None,
        'release build-info names no exact publisher run')
expected_run = f"https://github.com/{repository}/actions/runs/{build_info['run_id']}"
require(provenance.get('ciRun') == expected_run,
        'release provenance and build-info name different publisher runs')
PYTHON_RELEASE_IDENTITY
}

verify_complete_manifest() {
  local release_dir="$1"
  local check_path="$2"
  (
    cd "$release_dir"
    find . -type f ! -path './.release-manifest.sha256' -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum > "$check_path"
  )
  cmp -s "$check_path" "$release_dir/.release-manifest.sha256" \
    || { echo "the files under $release_dir are not the files its .release-manifest.sha256 records: $(diff "$release_dir/.release-manifest.sha256" "$check_path" | head -20 | tr '\n' ' ')" >&2; rm -f -- "$check_path"; return 1; }
  rm -f -- "$check_path"
}

seal_current_release_for_rollback() {
  local current_pointer="$1"
  local release_dir="$2"
  local expected_sha="$3"
  local repository="$4"
  local staged_manifest="$5"
  local check_path="$6"
  local manifest="$release_dir/.release-manifest.sha256"

  [ -L "$current_pointer" ] \
    || { echo "$current_pointer is not a symlink, so there is no release to seal for rollback; found: $(ls -ld -- "$current_pointer" 2>&1 || true)" >&2; return 1; }
  [ "$(readlink "$current_pointer")" = "$release_dir" ] \
    || { echo "$current_pointer points at $(readlink "$current_pointer"), not the $release_dir this transaction read; the board moved underneath it" >&2; return 1; }
  [ -d "$release_dir" ] \
    || { echo "$release_dir is not a directory; found: $(ls -ld -- "$release_dir" 2>&1 || true)" >&2; return 1; }
  [ ! -L "$release_dir" ] \
    || { echo "$release_dir is a symlink to $(readlink "$release_dir"); a release directory is never a link" >&2; return 1; }
  if find "$release_dir" -type l -print -quit | grep -q .; then
    echo 'current rollback release contains a symlink' >&2
    return 1
  fi
  if find "$release_dir" ! -type d ! -type f -print -quit | grep -q .; then
    echo 'current rollback release contains a special file' >&2
    return 1
  fi
  verify_release_identity "$release_dir" "$expected_sha" "$repository"

  if [ -e "$manifest" ] || [ -L "$manifest" ]; then
    [ -f "$manifest" ] && [ ! -L "$manifest" ] && [ -s "$manifest" ] \
      || { echo 'current rollback release manifest is malformed' >&2; return 1; }
  else
    [ ! -e "$staged_manifest" ] && [ ! -L "$staged_manifest" ] \
      || { echo "the legacy manifest staging path $staged_manifest already exists; found: $(ls -ld -- "$staged_manifest" 2>&1 || true)" >&2; return 1; }
    python3 - "$release_dir" "$staged_manifest" <<'PYTHON_SAME_FILESYSTEM'
import os
import sys

if os.stat(sys.argv[1]).st_dev != os.stat(os.path.dirname(sys.argv[2])).st_dev:
    raise SystemExit('legacy manifest staging is not on the release filesystem')
PYTHON_SAME_FILESYSTEM
    (
      cd "$release_dir"
      find . -type f ! -path './.release-manifest.sha256' -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 sha256sum > "$staged_manifest"
      test -s "$staged_manifest" \
        || { echo "sealing $release_dir produced an empty manifest at $staged_manifest; a release with no files is not a release" >&2; exit 1; }
      sha256sum --strict -c "$staged_manifest" >/dev/null
      find . -type f ! -path './.release-manifest.sha256' -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 sha256sum > "$check_path"
    )
    cmp -s "$staged_manifest" "$check_path" \
      || { echo "$release_dir changed while it was being sealed: the two passes over it disagree, so the rollback manifest is not written" >&2; return 1; }
    rm -f -- "$check_path"
    sync -f "$staged_manifest"
    [ "$(readlink "$current_pointer")" = "$release_dir" ] \
      || { echo "$current_pointer moved to $(readlink "$current_pointer") while $release_dir was being sealed; refusing to write a manifest into a release nobody serves" >&2; return 1; }
    mv -Tf "$staged_manifest" "$manifest"
    sync -f "$release_dir"
  fi

  (cd "$release_dir" && sha256sum --strict -c .release-manifest.sha256 >/dev/null)
  verify_complete_manifest "$release_dir" "$check_path"
}

CURRENT_SHA=$(read_exact_build_info_sha "$ROOT/current/build-info.json")
[ -L "$ROOT/current" ] \
  || { echo "$ROOT/current is not a symlink; found: $(ls -ld -- "$ROOT/current" 2>&1 || true)" >&2; exit 1; }
[ "$(readlink "$ROOT/current")" = "$ROOT/releases/$CURRENT_SHA" ] \
  || { echo "$ROOT/current points at $(readlink "$ROOT/current") while its build-info names $CURRENT_SHA; the pointer and the bytes disagree" >&2; exit 1; }
if [ "$CURRENT_SHA" != "$EXPECTED_SHA" ] && [ "$CURRENT_SHA" != "$SHA" ]; then
  echo "current changed from ${EXPECTED_SHA:0:7} to ${CURRENT_SHA:0:7}; refusing stale activation" >&2
  exit 75
fi
CURRENT_RELEASE="$ROOT/releases/$CURRENT_SHA"
seal_current_release_for_rollback \
  "$ROOT/current" \
  "$CURRENT_RELEASE" \
  "$CURRENT_SHA" \
  "$REPOSITORY" \
  "$LEGACY_MANIFEST" \
  "$CHECK"

test -d "$STAGE" \
  || { echo "the staging directory $STAGE this invocation transferred is gone; found: $(ls -ld -- "$STAGE" 2>&1 || true)" >&2; exit 1; }
test -s "$STAGE/.release-manifest.sha256" \
  || { echo "$STAGE carries no non-empty .release-manifest.sha256, so its bytes cannot be authenticated" >&2; exit 1; }
if find "$STAGE" -type l -print -quit | grep -q .; then
  echo 'incoming release contains a symlink' >&2
  exit 1
fi
if find "$STAGE" ! -type d ! -type f -print -quit | grep -q .; then
  echo 'incoming release contains a special file' >&2
  exit 1
fi
(cd "$STAGE" && sha256sum --strict -c .release-manifest.sha256 >/dev/null)
STAGED_SHA=$(read_exact_build_info_sha "$STAGE/build-info.json")
[ "$STAGED_SHA" = "$SHA" ] \
  || { echo "the staged bundle's build-info names $STAGED_SHA but this transaction is publishing $SHA" >&2; exit 1; }

verify_complete_manifest "$STAGE" "$CHECK"

if [ -e "$FINAL" ] || [ -L "$FINAL" ]; then
  [ -d "$FINAL" ] \
    || { echo "$FINAL exists but is not a directory; found: $(ls -ld -- "$FINAL" 2>&1 || true)" >&2; exit 1; }
  [ ! -L "$FINAL" ] \
    || { echo "$FINAL is a symlink to $(readlink "$FINAL"); a sealed release is never a link" >&2; exit 1; }
  test -s "$FINAL/.release-manifest.sha256" \
    || { echo "the already sealed release $FINAL carries no non-empty .release-manifest.sha256, so it cannot be proved immutable" >&2; exit 1; }
  if find "$FINAL" -type l -print -quit | grep -q .; then
    echo 'sealed release contains a symlink' >&2
    exit 1
  fi
  if find "$FINAL" ! -type d ! -type f -print -quit | grep -q .; then
    echo 'sealed release contains a special file' >&2
    exit 1
  fi
  (cd "$FINAL" && sha256sum --strict -c .release-manifest.sha256 >/dev/null)
  verify_complete_manifest "$FINAL" "$CHECK"
  # One source commit deliberately produces different envelope bytes
  # on a later build (build time, run id and service-worker deploy
  # stamp). The first complete releases/<sha> is canonical. A retry
  # must validate and reuse it, not demand that a nondeterministic
  # rebuild have the same manifest or replace immutable bytes.
  verify_release_identity "$FINAL" "$SHA" "$REPOSITORY"
  echo "reusing the already sealed immutable release for ${SHA:0:7}"
  rm -rf -- "$STAGE"
else
  mv -- "$STAGE" "$FINAL"
fi

# Runtime URLs are append-only so tabs opened on an older release keep
# working mid-hand. Not every file under assets/ has a content hash in
# its name, so an existing path may only be reused for identical bytes.
# Reject a collision before copying anything, then use --ignore-existing
# so even a stable path can never be overwritten in place. The one
# unhashed font stylesheet is a stable symlink through `current`, so it
# changes in the same atomic rename as the release.
# These three refused runs 35763554815 and 35764705782 on
# 2026-09-22 without printing one character, because a bare `test`
# under `set -e` exits 1 and says nothing (CLAUDE.md 10.86 rule 1).
# They were right to refuse: `self-host-fonts` could not reach
# Google Fonts, exited 0 anyway, and the bundle had no fonts/ at
# all. Activating it would have dangled the pool's fonts.css
# symlink for every shell already cached on a player's device.
test -d "$FINAL/assets" \
  || { echo "release $SHA has no assets directory at $FINAL/assets, so the append-only runtime pool cannot be filled from it; the release holds: $(ls -A1 -- "$FINAL" 2>&1 | tr '\n' ' ')" >&2; exit 1; }
test -d "$FINAL/fonts" \
  || { echo "release $SHA has no fonts directory at $FINAL/fonts; the pool's fonts.css points into current/fonts/fonts.css, so activating this release would 404 the fonts of every already-cached shell. A build whose self-host-fonts step could not reach Google Fonts produces exactly this bundle. The release holds: $(ls -A1 -- "$FINAL" 2>&1 | tr '\n' ' ')" >&2; exit 1; }
test -f "$FINAL/fonts/fonts.css" \
  || { echo "release $SHA has no regular file at $FINAL/fonts/fonts.css; found: $(ls -ld -- "$FINAL/fonts/fonts.css" 2>&1 || true). fonts holds: $(ls -A1 -- "$FINAL/fonts" 2>&1 | tr '\n' ' ')" >&2; exit 1; }

adopt_legacy_font_stylesheet_pointer() {
  local pointer="$1"
  local current_stylesheet="$2"
  local staged_pointer="$3"

  # The publisher that preceded this transaction copied fonts.css
  # into the additive pool as a regular file. Adopt that one known
  # legacy shape only when its bytes are exactly what `current`
  # already serves. Every other pre-existing shape fails closed.
  if [ -L "$pointer" ]; then
    [ "$(readlink "$pointer")" = "$current_stylesheet" ] \
      || { echo 'mutable font stylesheet pointer is malformed' >&2; return 1; }
    return 0
  fi
  [ -e "$pointer" ] || return 0
  [ -f "$pointer" ] && [ ! -L "$pointer" ] \
    || { echo 'legacy mutable font stylesheet is not a regular file' >&2; return 1; }
  [ -f "$current_stylesheet" ] && [ ! -L "$current_stylesheet" ] \
    || { echo 'current release font stylesheet is not a regular file' >&2; return 1; }
  cmp -s "$pointer" "$current_stylesheet" \
    || { echo 'legacy mutable font stylesheet differs from current release' >&2; return 1; }
  [ ! -e "$staged_pointer" ] && [ ! -L "$staged_pointer" ] \
    || { echo 'font stylesheet staging path already exists' >&2; return 1; }
  ln -s "$current_stylesheet" "$staged_pointer"
  mv -Tf "$staged_pointer" "$pointer"
  [ -L "$pointer" ] && [ "$(readlink "$pointer")" = "$current_stylesheet" ] \
    || { echo 'legacy font stylesheet adoption did not create the canonical pointer' >&2; return 1; }
}

assert_additive_pool_has_no_collision() {
  local source_root="$1"
  local pool_root="$2"
  local ignored_path="${3:-}"
  local source_file relative_path pooled_file
  while IFS= read -r -d '' source_file; do
    relative_path="${source_file#"$source_root"/}"
    [ -n "$relative_path" ] \
      || { echo "the pool walker could not make $source_file relative to $source_root" >&2; return 1; }
    [ "$relative_path" = "$ignored_path" ] && continue
    pooled_file="$pool_root/$relative_path"
    if [ -e "$pooled_file" ] || [ -L "$pooled_file" ]; then
      [ -f "$pooled_file" ] && [ ! -L "$pooled_file" ] \
        || { echo "pooled runtime path is not a regular file: $relative_path" >&2; return 1; }
      cmp -s "$source_file" "$pooled_file" \
        || { echo "pooled runtime URL would change bytes: $relative_path" >&2; return 1; }
    fi
  done < <(find "$source_root" -type f -print0)
}

prove_additive_pool_contains_release() {
  local source_root="$1"
  local pool_root="$2"
  local ignored_path="${3:-}"
  local source_file relative_path pooled_file
  while IFS= read -r -d '' source_file; do
    relative_path="${source_file#"$source_root"/}"
    [ -n "$relative_path" ] \
      || { echo "the pool walker could not make $source_file relative to $source_root" >&2; return 1; }
    [ "$relative_path" = "$ignored_path" ] && continue
    pooled_file="$pool_root/$relative_path"
    [ -f "$pooled_file" ] && [ ! -L "$pooled_file" ] \
      && cmp -s "$source_file" "$pooled_file" \
      || { echo "pooled runtime URL is absent or changed: $relative_path" >&2; return 1; }
  done < <(find "$source_root" -type f -print0)
}

if find "$ROOT/pool/assets" -type l -print -quit | grep -q . \
  || find "$ROOT/pool/fonts" -type l ! -path "$ROOT/pool/fonts/fonts.css" -print -quit | grep -q .; then
  echo 'additive runtime pool contains a symlink' >&2
  exit 1
fi
adopt_legacy_font_stylesheet_pointer \
  "$ROOT/pool/fonts/fonts.css" \
  "$ROOT/current/fonts/fonts.css" \
  "$FONT_NEXT"
assert_additive_pool_has_no_collision "$FINAL/assets" "$ROOT/pool/assets"
assert_additive_pool_has_no_collision "$FINAL/fonts" "$ROOT/pool/fonts" 'fonts.css'
rsync -a --ignore-existing --fsync "$FINAL/assets/" "$ROOT/pool/assets/"
rsync -a --ignore-existing --fsync --exclude='/fonts.css' "$FINAL/fonts/" "$ROOT/pool/fonts/"
prove_additive_pool_contains_release "$FINAL/assets" "$ROOT/pool/assets"
prove_additive_pool_contains_release "$FINAL/fonts" "$ROOT/pool/fonts" 'fonts.css'
ln -s "$ROOT/current/fonts/fonts.css" "$FONT_NEXT"
mv -Tf "$FONT_NEXT" "$ROOT/pool/fonts/fonts.css"

# Reject unknown release directory names rather than handing them to
# a pruning command. The current and candidate releases are never
# eligible for deletion, even if their mtimes are old.
mapfile -t RELEASE_NAMES < <(
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n'
)
for RELEASE_NAME in "${RELEASE_NAMES[@]}"; do
  [[ "$RELEASE_NAME" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "$ROOT/releases holds '$RELEASE_NAME', which is not a 40 character lowercase SHA; refusing to hand an unknown name to a pruning command" >&2; exit 1; }
done
mapfile -t RELEASE_NAMES < <(
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' \
    | sort -rn | awk '{print $2}'
)
for ((INDEX=KEEP_RELEASES; INDEX<${#RELEASE_NAMES[@]}; INDEX++)); do
  RELEASE_NAME="${RELEASE_NAMES[$INDEX]}"
  [ "$RELEASE_NAME" = "$CURRENT_SHA" ] && continue
  [ "$RELEASE_NAME" = "$SHA" ] && continue
  rm -rf -- "$ROOT/releases/$RELEASE_NAME"
done
find "$ROOT/pool" -type f -name '*.map' -delete

# Flush the release, pool, and directory metadata before the public
# pointer changes. Flush the atomic rename itself before success.
sync -f "$ROOT"
CURRENT_BEFORE_SWAP=$(read_exact_build_info_sha "$ROOT/current/build-info.json")
[ "$CURRENT_BEFORE_SWAP" = "$CURRENT_SHA" ] || [ "$CURRENT_BEFORE_SWAP" = "$SHA" ] \
  || { echo "$ROOT/current now serves $CURRENT_BEFORE_SWAP; it was $CURRENT_SHA when this transaction read it and the candidate is $SHA. Another publish moved it, so this one stops before the swap" >&2; exit 1; }
[ ! -e "$NEXT" ] && [ ! -L "$NEXT" ] \
  || { echo "the pointer staging path $NEXT already exists; found: $(ls -ld -- "$NEXT" 2>&1 || true)" >&2; exit 1; }
ln -s "$FINAL" "$NEXT"
mv -Tf "$NEXT" "$ROOT/current"
sync -f "$ROOT"
[ "$(readlink "$ROOT/current")" = "$FINAL" ] \
  || { echo "the atomic swap left $ROOT/current pointing at $(readlink "$ROOT/current"), not $FINAL" >&2; exit 1; }
