#!/usr/bin/env bash
# Install one immutable, protected-main Club Arena engine control generation.
# Game releases do not manage operator SSH keys, host firewall policy, or
# fail2ban. Those host-security controls are prerequisites outside this narrow
# engine-release authority and are never rewritten as a side effect of a game.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/club-arena}"
CONTROL_DIR="${ENGINE_CONTROL_DIR:-/usr/local/lib/club-arena/engine-control}"
CONTROL_PARENT="$(dirname "$CONTROL_DIR")"
GENERATION_ROOT="$CONTROL_PARENT/engine-control-generations"
UNIT_WRAPPER_V1="$CONTROL_PARENT/engine-release-unit-wrapper-v1.sh"
RELEASE_UNIT_V1="/etc/systemd/system/club-arena-engine-release-v1@.service"
PROTOCOL_V1_FILE="engine-release-protocol-v1.schema"
PROTOCOL_V1_SHA256="7c5aba4d2bc572edc5ef84c5280e1ffe517e5949b41788c18eeb003abea74044"
LOCK_FILE="${LOCK_FILE:-/var/lock/club-arena-engine-up.lock}"
SOURCE_LOCK="${SOURCE_LOCK_FILE:-/var/lock/club-arena-source.lock}"
CONTROL_SHA="${ENGINE_CONTROL_SHA:-}"
RUN_ID="${ENGINE_RELEASE_RUN_ID:-}"
RUN_URL="${ENGINE_RELEASE_RUN_URL:-}"
RUN_ACTOR="${ENGINE_RELEASE_ACTOR:-}"

REQUIRED_FILES=(
  engine-supervisor.sh
  engine-up.sh
  build-engine-image.sh
  engine-release-protocol-v1.schema
  engine-release-seal.py
  verify-recovery-stack.sh
  engine-release-database-proof.py
  engine-release-transaction.sh
  engine-release-recover.sh
  engine-release-unit-wrapper.sh
  observe-engine-release.sh
  launch-engine-release.sh
  engine-release-intake.sh
  install-engine-intake.sh
  retain-engine-images.sh
  install-engine-supervisor.sh
)
CORE_FILES=(
  engine-supervisor.sh
  engine-up.sh
  engine-release-protocol-v1.schema
  engine-release-seal.py
  verify-recovery-stack.sh
)

die() {
  echo "[install-engine-supervisor] FATAL: $*" >&2
  exit 1
}

retry() {
  echo "[install-engine-supervisor] RETRY: $*" >&2
  exit 75
}

fsync_paths() {
  python3 - "$@" <<'PY'
import os, sys
for path in sys.argv[1:]:
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if os.path.isdir(path) else 0)
    fd = os.open(path, flags)
    try: os.fsync(fd)
    finally: os.close(fd)
PY
}

validate_v1_protocol() {
  local generation="$1" declaration digest
  declaration="$generation/$PROTOCOL_V1_FILE"
  [ -f "$declaration" ] && [ ! -L "$declaration" ] \
    || die "control generation has no regular $PROTOCOL_V1_FILE declaration"
  digest="$(python3 - "$declaration" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)" || die 'could not hash the release protocol declaration'
  [ "$digest" = "$PROTOCOL_V1_SHA256" ] \
    || die 'control generation is incompatible with the frozen release v1 protocol'
}

validate_active_generation() {
  local sha="$1" active expected file
  active="$(readlink -e -- "$CONTROL_DIR")" || die 'active control target is unavailable'
  expected="$GENERATION_ROOT/$sha"
  [ "$active" = "$expected" ] && [ -d "$active" ] && [ ! -L "$active" ] \
    || die 'active control target is not its canonical deterministic generation'
  validate_v1_protocol "$active"
  [ -f "$active/generation-files" ] \
    || die 'active deterministic control generation has no immutable file manifest'
  mapfile -t ACTIVE_FILES < "$active/generation-files" \
    || die 'active deterministic control generation file manifest is unreadable'
  python3 - "$active" "${CORE_FILES[@]}" <<'PY' \
    || die 'active deterministic control generation manifest or filesystem is invalid'
import os, re, stat, sys
root = sys.argv[1]
core = set(sys.argv[2:])
with open(os.path.join(root, 'generation-files'), encoding='utf-8') as handle:
    names = handle.read().splitlines()
if not names or len(names) != len(set(names)) or not core.issubset(set(names)):
    raise SystemExit(1)
if any(not re.fullmatch(r'[A-Za-z0-9._-]+', name) for name in names):
    raise SystemExit(1)
expected = set(names) | {'control-sha', 'generation-files'}
if set(os.listdir(root)) != expected:
    raise SystemExit(1)
for name in expected:
    mode = os.lstat(os.path.join(root, name)).st_mode
    if not stat.S_ISREG(mode):
        raise SystemExit(1)
PY
  for file in "${ACTIVE_FILES[@]}"; do
    GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" show "$sha:server/scripts/$file" \
      | cmp -s - "$active/$file" \
      || die "active control generation differs from protected commit bytes: $file"
  done
}

[ "$(id -u)" = 0 ] || die 'must run as root'
[[ "$CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die 'ENGINE_CONTROL_SHA must be one lowercase 40-hex commit'
[[ "$RUN_ID" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || die 'audited release run key is required'
[ "$RUN_URL" = "https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/${RUN_ID%%-*}" ] \
  || die 'audited release URL does not match the run key'
python3 - "$RUN_ACTOR" <<'PY' || die 'audited release actor is invalid'
import sys
value = sys.argv[1]
raise SystemExit(0 if value and len(value) <= 128 and all(ord(c) >= 32 and ord(c) != 127 for c in value) else 1)
PY
[ -d "$REPO_DIR/.git" ] || die 'Club Arena Git object store is missing'

# All installers take the engine lock before the source lock. This serializes
# bootstrap/seal and generation activation against an actual cutover, while
# immutable run pins keep long image builds and break waits generation-stable.
exec 9>"$LOCK_FILE"
flock -w 600 9 || retry "could not acquire $LOCK_FILE for control-plane installation"
exec 8>"$SOURCE_LOCK"
flock -w 90 8 || retry "could not acquire $SOURCE_LOCK"

FETCHED=0
for attempt in 1 2 3; do
  if GIT_NO_REPLACE_OBJECTS=1 GIT_HTTP_LOW_SPEED_LIMIT=1024 GIT_HTTP_LOW_SPEED_TIME=15 \
    timeout --signal=TERM --kill-after=5s 30s \
    git -C "$REPO_DIR" fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'; then
    FETCHED=1
    break
  fi
  [ "$attempt" = 3 ] || sleep 3
done
[ "$FETCHED" = 1 ] || retry 'protected-main fetch failed after three bounded attempts'
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" cat-file -e "$CONTROL_SHA^{commit}"
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" merge-base --is-ancestor "$CONTROL_SHA" origin/main \
  || die 'control SHA is not contained in protected main'

ACTIVE_CONTROL_SHA=''
ACTIVE_IS_CURRENT_GENERATION=0
if [ -L "$CONTROL_DIR" ] && [ -r "$CONTROL_DIR/control-sha" ]; then
  ACTIVE_CONTROL_SHA="$(tr -d '\r\n' < "$CONTROL_DIR/control-sha")"
  [[ "$ACTIVE_CONTROL_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || die 'active control generation has an invalid SHA manifest'
  GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" cat-file -e "$ACTIVE_CONTROL_SHA^{commit}"
  GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" merge-base --is-ancestor "$ACTIVE_CONTROL_SHA" origin/main \
    || die 'active control generation is no longer contained in protected main'
  ACTIVE_TARGET="$(readlink -e -- "$CONTROL_DIR")" \
    || die 'active control generation target is unavailable'
  case "$ACTIVE_TARGET" in
    "$GENERATION_ROOT"/*) ;;
    *) die 'active control generation is outside the managed generation root' ;;
  esac
  if [ "$ACTIVE_TARGET" = "$GENERATION_ROOT/$ACTIVE_CONTROL_SHA" ]; then
    validate_active_generation "$ACTIVE_CONTROL_SHA"
    ACTIVE_IS_CURRENT_GENERATION=1
  else
    # Predecessor installers used a random generation directory. Its manifest
    # SHA is used only for the protected-main ancestry/downgrade decision; no
    # executable byte from that directory is trusted or invoked here.
    echo "migrating predecessor control generation $ACTIVE_TARGET"
  fi
  if [ "$ACTIVE_CONTROL_SHA" != "$CONTROL_SHA" ]; then
    if GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" merge-base --is-ancestor "$CONTROL_SHA" "$ACTIVE_CONTROL_SHA"; then
      [ "$ACTIVE_IS_CURRENT_GENERATION" = 1 ] \
        || die 'unvalidated predecessor claims a newer control SHA; only its authoritative newer intake may dispatch'
      echo "control generation $ACTIVE_CONTROL_SHA is newer; refusing downgrade to $CONTROL_SHA"
      echo "ENGINE_CONTROL_INSTALL_SHA=$ACTIVE_CONTROL_SHA"
      echo "ENGINE_CONTROL_INSTALL_GENERATION=$ACTIVE_TARGET"
      exit 0
    fi
    GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" merge-base --is-ancestor "$ACTIVE_CONTROL_SHA" "$CONTROL_SHA" \
      || die 'control generations diverge'
  fi
elif [ -L "$CONTROL_DIR" ]; then
  # The original immutable-generation installer did not write a control-sha
  # manifest and named directories by run and timestamp. Accept exactly that
  # structural shape as a one-time replacement target. We deliberately do not
  # execute it or infer release authority from its mutable contents.
  ACTIVE_TARGET="$(readlink -e -- "$CONTROL_DIR")" \
    || die 'legacy control generation target is unavailable'
  case "$ACTIVE_TARGET" in
    "$GENERATION_ROOT"/*) ;;
    *) die 'legacy control generation is outside the managed generation root' ;;
  esac
  [ -d "$ACTIVE_TARGET" ] && [ ! -L "$ACTIVE_TARGET" ] \
    || die 'legacy control generation target is not an immutable directory'
  echo "migrating unmanifested predecessor control generation $ACTIVE_TARGET"
elif [ -e "$CONTROL_DIR" ]; then
  die "$CONTROL_DIR exists but is not the managed generation symlink"
fi

# Ignore caller-supplied source directories. Materialize every installed byte
# from the authenticated commit object with replacement refs disabled.
ARCHIVE_STAGE="$(mktemp -d /run/club-arena-control-archive.XXXXXXXX)"
UNIT_STAGE="$(mktemp -d /run/club-arena-engine-units.XXXXXXXX)"
GENERATION_STAGE=''
NEXT_WRAPPER=''
NEXT_LINK=''
NEXT_UNIT=''
NEXT_RELEASE_UNIT=''
cleanup_stages() {
  for path in "$ARCHIVE_STAGE" "$UNIT_STAGE" "${GENERATION_STAGE:-}"; do
    [ -n "$path" ] || continue
    case "$path" in
      /run/club-arena-control-archive.*|/run/club-arena-engine-units.*|"$GENERATION_ROOT"/.generation.*)
        rm -rf -- "$path"
        ;;
      *) echo "[install-engine-supervisor] refusing unsafe stage cleanup: $path" >&2 ;;
    esac
  done
  for path in "$NEXT_WRAPPER" "$NEXT_LINK" "$NEXT_UNIT" "$NEXT_RELEASE_UNIT"; do
    [ -n "$path" ] || continue
    case "$path" in
      "$CONTROL_PARENT"/.engine-release-unit-wrapper-v1.next.*|\
      "$CONTROL_PARENT"/.engine-control.next.*|\
      /etc/systemd/system/.*.next.*)
        rm -f -- "$path"
        ;;
      *) echo "[install-engine-supervisor] refusing unsafe temporary-file cleanup: $path" >&2 ;;
    esac
  done
}
trap cleanup_stages EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
GIT_NO_REPLACE_OBJECTS=1 git -C "$REPO_DIR" archive "$CONTROL_SHA" server/scripts \
  | tar --no-same-owner -xf - -C "$ARCHIVE_STAGE"
SOURCE_DIR="$ARCHIVE_STAGE/server/scripts"
for file in "${REQUIRED_FILES[@]}"; do
  [ -f "$SOURCE_DIR/$file" ] || die "control commit is missing server/scripts/$file"
done
validate_v1_protocol "$SOURCE_DIR"

install -d -m 0755 "$CONTROL_PARENT" "$GENERATION_ROOT"
fsync_paths "$GENERATION_ROOT" "$CONTROL_PARENT" "$(dirname "$CONTROL_PARENT")"
GENERATION_DIR="$GENERATION_ROOT/$CONTROL_SHA"
if [ -e "$GENERATION_DIR" ]; then
  [ -d "$GENERATION_DIR" ] && [ ! -L "$GENERATION_DIR" ] \
    || die 'existing deterministic control generation is not an immutable directory'
  [ "$(tr -d '\r\n' < "$GENERATION_DIR/control-sha")" = "$CONTROL_SHA" ] \
    || die 'existing deterministic control generation has the wrong manifest'
  printf '%s\n' "${REQUIRED_FILES[@]}" \
    | cmp -s - "$GENERATION_DIR/generation-files" \
    || die 'existing deterministic control generation has the wrong file manifest'
  python3 - "$GENERATION_DIR" "${REQUIRED_FILES[@]}" <<'PY' \
    || die 'existing deterministic control generation has unexpected filesystem entries'
import os, stat, sys
root = sys.argv[1]
expected = set(sys.argv[2:]) | {'control-sha', 'generation-files'}
if set(os.listdir(root)) != expected:
    raise SystemExit(1)
for name in expected:
    if not stat.S_ISREG(os.lstat(os.path.join(root, name)).st_mode):
        raise SystemExit(1)
PY
  for file in "${REQUIRED_FILES[@]}"; do
    cmp -s "$SOURCE_DIR/$file" "$GENERATION_DIR/$file" \
      || die "existing control generation differs from commit bytes: $file"
  done
  validate_v1_protocol "$GENERATION_DIR"
else
  GENERATION_STAGE="$(mktemp -d "$GENERATION_ROOT/.generation.XXXXXXXX")"
  for file in "${REQUIRED_FILES[@]}"; do
    if [ "$file" = "$PROTOCOL_V1_FILE" ]; then
      install -m 0644 "$SOURCE_DIR/$file" "$GENERATION_STAGE/$file"
    else
      install -m 0755 "$SOURCE_DIR/$file" "$GENERATION_STAGE/$file"
    fi
  done
  printf '%s\n' "${REQUIRED_FILES[@]}" > "$GENERATION_STAGE/generation-files"
  printf '%s\n' "$CONTROL_SHA" > "$GENERATION_STAGE/control-sha"
  chmod 0644 "$GENERATION_STAGE/control-sha" "$GENERATION_STAGE/generation-files"
  for script in \
    engine-supervisor.sh engine-up.sh build-engine-image.sh verify-recovery-stack.sh \
    engine-release-transaction.sh engine-release-recover.sh engine-release-unit-wrapper.sh \
    observe-engine-release.sh launch-engine-release.sh engine-release-intake.sh \
    install-engine-intake.sh retain-engine-images.sh install-engine-supervisor.sh; do
    bash -n "$GENERATION_STAGE/$script"
  done
  for script in engine-release-seal.py engine-release-database-proof.py; do
    python3 -c 'compile(open(__import__("sys").argv[1], encoding="utf-8").read(), __import__("sys").argv[1], "exec")' \
      "$GENERATION_STAGE/$script"
  done
  validate_v1_protocol "$GENERATION_STAGE"
  fsync_paths "$GENERATION_STAGE"/* "$GENERATION_STAGE" "$GENERATION_ROOT"
  mv -T "$GENERATION_STAGE" "$GENERATION_DIR"
  GENERATION_STAGE=''
  fsync_paths "$GENERATION_ROOT"
fi

install -d -m 0700 /var/lib/club-arena
fsync_paths /var/lib/club-arena /var/lib
timeout --signal=TERM --kill-after=2s 10s docker info >/dev/null 2>&1 \
  || retry 'Docker is unavailable before release-seal bootstrap'
set +e
"$GENERATION_DIR/engine-release-seal.py" bootstrap-running \
  --container "${CONTAINER:-club-arena-engine}" --repo "$REPO_DIR" \
  --run-id "$RUN_ID" --run-url "$RUN_URL" --actor "$RUN_ACTOR" \
  --reason "${ENGINE_RELEASE_REASON:-install protected-main engine release authority}"
BOOTSTRAP_RC=$?
set -e
if [ "$BOOTSTRAP_RC" -ne 0 ]; then
  timeout --signal=TERM --kill-after=2s 10s docker info >/dev/null 2>&1 \
    || retry "Docker disappeared during release-seal bootstrap (status $BOOTSTRAP_RC)"
  die "release-seal bootstrap failed while Docker remained available (status $BOOTSTRAP_RC)"
fi

# The v1 wrapper is a deliberately frozen request protocol. Future changes
# need a separately named wrapper and unit migration; silently replacing this
# executable could split ExecStart and ExecStopPost across incompatible bytes.
if [ -e "$UNIT_WRAPPER_V1" ]; then
  cmp -s "$SOURCE_DIR/engine-release-unit-wrapper.sh" "$UNIT_WRAPPER_V1" \
    || die 'stable release wrapper v1 differs; an explicit protocol migration is required'
else
  NEXT_WRAPPER="$CONTROL_PARENT/.engine-release-unit-wrapper-v1.next.$$"
  install -m 0755 "$SOURCE_DIR/engine-release-unit-wrapper.sh" "$NEXT_WRAPPER"
  bash -n "$NEXT_WRAPPER"
  fsync_paths "$NEXT_WRAPPER" "$CONTROL_PARENT"
  mv -T "$NEXT_WRAPPER" "$UNIT_WRAPPER_V1"
  NEXT_WRAPPER=''
  fsync_paths "$CONTROL_PARENT"
fi

# Unit policy is static and generation-independent. The supervisor resolves the
# active symlink per invocation; the release wrapper reads a request-bound
# immutable generation. Thus every on-disk unit remains complete across a
# crash, even before daemon-reload or control-symlink activation.
cat > "$UNIT_STAGE/club-arena-supervisor.service" <<UNIT
[Unit]
Description=Club Arena engine supervisor (guarantees the engine is up and serving)
After=docker.service
Requires=docker.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=$CONTROL_DIR/engine-supervisor.sh
Environment=ENGINE_CONTROL_DIR=$CONTROL_DIR
UNIT

cat > "$UNIT_STAGE/club-arena-supervisor.timer" <<'UNIT'
[Unit]
Description=Run the Club Arena engine supervisor every 60s

[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=club-arena-supervisor.service

[Install]
WantedBy=timers.target
UNIT

cat > "$UNIT_STAGE/club-arena-verify.service" <<UNIT
[Unit]
Description=Verify the Club Arena recovery stack is still wired up
After=docker.service

[Service]
Type=oneshot
ExecStart=$CONTROL_DIR/verify-recovery-stack.sh
Environment=ENGINE_CONTROL_DIR=$CONTROL_DIR
UNIT

cat > "$UNIT_STAGE/club-arena-verify.timer" <<'UNIT'
[Unit]
Description=Daily Club Arena recovery-stack verification

[Timer]
OnCalendar=*-*-* 09:17:00 UTC
Persistent=true
RandomizedDelaySec=120
Unit=club-arena-verify.service

[Install]
WantedBy=timers.target
UNIT

cat > "$UNIT_STAGE/club-arena-engine-release-v1@.service" <<UNIT
[Unit]
Description=Club Arena Engine Release Transaction %i
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=$UNIT_WRAPPER_V1 start %i
ExecStopPost=$UNIT_WRAPPER_V1 recover %i \${SERVICE_RESULT} \${EXIT_CODE} \${EXIT_STATUS}
TimeoutStartSec=145min
# ExecStopPost owns up to 300 seconds of exact desired recovery plus bounded
# receipt validation and durable retirement overhead.
TimeoutStopSec=330s
Restart=on-failure
RestartForceExitStatus=75
RestartPreventExitStatus=1
RestartSec=30s
KillMode=control-group
NoNewPrivileges=false
PrivateTmp=true
ProtectHome=tmpfs
BindReadOnlyPaths=/root/.ssh
ProtectSystem=full
ReadWritePaths=/var/lib/club-arena /var/lock /var/log/club-arena-engine /opt/club-arena /etc/systemd/system/multi-user.target.wants

[Install]
WantedBy=multi-user.target
UNIT

systemd-analyze verify "$UNIT_STAGE"/*
fsync_paths "$UNIT_STAGE"/* "$UNIT_STAGE"
for unit_name in \
  club-arena-supervisor.service club-arena-supervisor.timer \
  club-arena-verify.service club-arena-verify.timer; do
  NEXT_UNIT="/etc/systemd/system/.$unit_name.next.$$"
  install -m 0644 "$UNIT_STAGE/$unit_name" "$NEXT_UNIT"
  fsync_paths "$NEXT_UNIT"
  mv -T "$NEXT_UNIT" "/etc/systemd/system/$unit_name"
  NEXT_UNIT=''
done

# Like its wrapper, the v1 unit policy is a frozen protocol boundary. Never
# rewrite the template underneath an older running transaction; incompatible
# policy requires a separately named v2 unit and explicit migration.
NEXT_RELEASE_UNIT="/etc/systemd/system/.club-arena-engine-release-v1.next.$$"
install -m 0644 "$UNIT_STAGE/club-arena-engine-release-v1@.service" "$NEXT_RELEASE_UNIT"
fsync_paths "$NEXT_RELEASE_UNIT"
if ! ln -- "$NEXT_RELEASE_UNIT" "$RELEASE_UNIT_V1" 2>/dev/null; then
  [ -f "$RELEASE_UNIT_V1" ] && [ ! -L "$RELEASE_UNIT_V1" ] \
    || die 'frozen release v1 unit is not a regular file'
  [ "$(stat -c '%u:%a' "$RELEASE_UNIT_V1")" = '0:644' ] \
    || die 'frozen release v1 unit ownership or mode is invalid'
  cmp -s "$NEXT_RELEASE_UNIT" "$RELEASE_UNIT_V1" \
    || die 'frozen release v1 unit differs; install a new protocol version instead'
fi
rm -f -- "$NEXT_RELEASE_UNIT"
NEXT_RELEASE_UNIT=''
fsync_paths /etc/systemd/system
systemctl daemon-reload || retry 'systemd daemon-reload failed'

if [ "$ACTIVE_IS_CURRENT_GENERATION" != 1 ]; then
  NEXT_LINK="$CONTROL_PARENT/.engine-control.next.$$"
  rm -f -- "$NEXT_LINK"
  ln -s "$GENERATION_DIR" "$NEXT_LINK"
  fsync_paths "$CONTROL_PARENT"
  mv -Tf "$NEXT_LINK" "$CONTROL_DIR"
  NEXT_LINK=''
  fsync_paths "$CONTROL_PARENT"
fi

systemctl enable --now club-arena-supervisor.timer \
  || retry 'could not activate the engine supervisor timer'
systemctl is-enabled club-arena-supervisor.timer | grep -qx enabled \
  || retry 'engine supervisor timer is not durably enabled'
systemctl enable --now club-arena-verify.timer \
  || retry 'could not activate the recovery verification timer'
systemctl is-enabled club-arena-verify.timer | grep -qx enabled \
  || retry 'recovery verification timer is not durably enabled'
systemctl enable docker >/dev/null \
  || retry 'could not enable Docker for host boot'
systemctl is-enabled docker | grep -qx enabled \
  || retry 'Docker is not durably enabled'

cleanup_stages
trap - EXIT HUP INT TERM
echo 'installed immutable Club Arena engine control generation:' "$CONTROL_SHA"
echo "ENGINE_CONTROL_INSTALL_SHA=$CONTROL_SHA"
echo "ENGINE_CONTROL_INSTALL_GENERATION=$GENERATION_DIR"
systemctl list-timers --no-legend --no-pager 'club-arena-*' \
  || retry 'could not read the installed Club Arena timers'
