#!/usr/bin/env bash
#
# ==============================================================================
#  install-turn-relay.sh -- coturn for Club Arena table voice, on Ubuntu 24.04
# ==============================================================================
#
# THIS SCRIPT HAS NEVER BEEN RUN. It is written to be read first and executed
# second, by a human who has decided which host the relay belongs on. Read
# docs/voice-turn-relay.md before running it -- in particular the CO-TENANCY
# section, because the obvious candidate host is shared with an unrelated
# business and a misconfigured relay on a shared box can reach that business's
# private services.
#
# WHY A RELAY EXISTS AT ALL
# -------------------------
# Table voice is a peer-to-peer WebRTC audio mesh on public STUN. Two problems:
#
#   1. STUN cannot traverse a symmetric NAT, which is what most mobile carrier
#      networks are. Those players get no audio at all, not worse audio.
#   2. A p2p mesh hands every participant's public IP address to every other
#      participant, because that is what an ICE candidate is. At a real-money
#      table full of strangers, that is a collusion and harassment surface.
#
# A TURN relay closes both. A relayed candidate carries the RELAY's address, so
# a peer's own address never leaves the relay, and the relay is reachable from
# behind any NAT because the client dials out to it.
#
# WHAT IT INSTALLS
# ----------------
#   - coturn, from the Ubuntu archive (no third-party repo, no new vendor)
#   - /etc/turnserver.conf, written from the template below
#   - a static-auth-secret GENERATED HERE, on this host, at install time
#   - firewall ALLOW rules for 3478/udp, 3478/tcp and the relay port range
#   - the systemd unit, enabled so it survives a reboot
#
# WHAT IT NEVER DOES
# ------------------
#   - it never removes, reorders or narrows an existing firewall rule
#   - it never touches, restarts or reads any other service on the host
#   - it never contains a secret; the secret is created at run time and stays
#     on the host in a root-only file
#   - it never restarts the Club Arena engine (see --write-engine-env below:
#     the value is staged for the NEXT natural deploy, deliberately)
#
# USAGE
#   sudo bash scripts/install-turn-relay.sh [options]
#
#   --dry-run               Print every change it would make and exit 0.
#   --public-ip <addr>      The address clients reach. Default: auto-detected.
#   --realm <name>          Default: smarter.poker
#   --max-port <n>          Top of the relay range. Default: 53247.
#   --write-engine-env      Append TURN_* to /opt/club-arena/server/.env so the
#                           next deploy picks them up. Does NOT restart anything.
#   --print-secret          Echo the secret to stdout. OFF by default, because
#                           stdout ends up in scrollback and in CI logs.
#   --force                 Proceed past the "something already owns this port"
#                           refusal. Read what it said first.
#
# ROLLBACK is printed at the end of every successful run, and is also in
# docs/voice-turn-relay.md. Nothing here is irreversible.
#
set -euo pipefail

# ------------------------------------------------------------------------------
# Defaults
# ------------------------------------------------------------------------------

REALM="smarter.poker"
LISTENING_PORT=3478
PUBLIC_IP=""
DRY_RUN=0
WRITE_ENGINE_ENV=0
PRINT_SECRET=0
FORCE=0

# THE RELAY PORT RANGE, AND THE ARITHMETIC BEHIND IT.
#
# coturn's default is 49152-65535: sixteen thousand ports, opened on a firewall,
# on a box shared with somebody else's business. That is a large surface for no
# reason, so this narrows it, and the number is derived rather than guessed:
#
#   a nine-seat table is a full mesh, so each player holds 8 peer connections
#     -> 9 * 8 = 72 relay allocations for one full table
#   browsers use rtcp-mux, so one allocation is one port; allow 2x headroom for
#   a client that does not, and for the TCP variant
#     -> about 144 ports per fully-occupied nine-handed table
#
# 4096 ports therefore covers roughly 28 simultaneous nine-handed voice tables,
# which is far past anything this platform has seen, while being a quarter of
# coturn's default surface. If that ceiling is ever reached, raise --max-port
# AND the firewall rule together -- they are two halves of one change.
MIN_RELAY_PORT=49152
MAX_RELAY_PORT=53247

# Per-user and total bandwidth ceilings, in kilobits per second.
#
# Opus speech is roughly 24-40 kbit/s per stream. A player in a nine-handed
# relayed mesh sends 8 copies out and receives 8 in, so about 640 kbit/s of
# relay traffic in the worst case. 2000 leaves generous headroom for one player
# and still makes a hijacked credential useless for anything but talking:
# nobody proxies video, a download or a botnet through a 2 Mbit/s ceiling.
#
# 200 Mbit/s total is the whole-relay cap. On a SHARED host, this is the number
# that stops a busy Saturday night (or an abuser) from starving the co-tenant's
# traffic. It is deliberately well under the NIC.
USER_QUOTA_KBPS=2000
TOTAL_QUOTA_KBPS=200000

CONF="/etc/turnserver.conf"
DEFAULTS="/etc/default/coturn"
SECRET_FILE="/root/club-arena-turn-secret"
ENGINE_ENV="/opt/club-arena/server/.env"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ------------------------------------------------------------------------------
# Argument parsing
# ------------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --public-ip) PUBLIC_IP="${2:?--public-ip needs a value}"; shift ;;
    --realm) REALM="${2:?--realm needs a value}"; shift ;;
    --max-port) MAX_RELAY_PORT="${2:?--max-port needs a value}"; shift ;;
    --write-engine-env) WRITE_ENGINE_ENV=1 ;;
    --print-secret) PRINT_SECRET=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { echo "[turn-install] $*"; }
warn() { echo "[turn-install] WARNING: $*" >&2; }
die()  { echo "[turn-install] FATAL: $*" >&2; exit 1; }

# Every mutating command goes through this, so --dry-run is honest rather than
# approximate: there is exactly one place a change can happen.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

# ==============================================================================
# STAGE 0 -- REFUSE TO PROCEED IF THIS WOULD DISTURB SOMETHING
# ==============================================================================
#
# The candidate host is CO-TENANTED. Every check here exists because getting it
# wrong takes down somebody else's production, not ours.

log "stage 0: pre-flight"

[ "$(id -u)" = "0" ] || die "must run as root (sudo bash $0)"

if [ ! -r /etc/os-release ]; then
  die "cannot read /etc/os-release -- this script targets Ubuntu 24.04 only"
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  warn "expected Ubuntu 24.04, found ${ID:-?} ${VERSION_ID:-?}. Continuing, but the"
  warn "package names and the systemd unit name are the 24.04 ones."
fi

# --- Record every service that is running BEFORE we touch anything. -----------
# Stage 6 compares against this. A relay install that stops a neighbour's
# service must be caught by the script that caused it, not by the neighbour.
PRE_RUNNING="$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null \
  | awk '{print $1}' | sort || true)"
log "services running before this change: $(echo "$PRE_RUNNING" | wc -l | tr -d ' ')"

# --- Named neighbours that must not be disturbed. -----------------------------
# Preserve the live poker infrastructure. PRE_RUNNING also captures every
# other active service, and stage 6 verifies that all remain running.
for neighbour in caddy.service docker.service; do
  if systemctl is-active --quiet "$neighbour" 2>/dev/null; then
    log "  neighbour up, will be left alone: $neighbour"
  fi
done
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx club-arena-engine; then
  log "  neighbour up, will be left alone: container club-arena-engine"
fi

# --- Nothing may already own the ports we are about to claim. -----------------
port_owner() {
  # $1 = port, $2 = tcp|udp. Prints the owning process, or nothing.
  ss -H -lnp"${2:0:1}" 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $NF}' | head -1
}
CONFLICT=0
for proto in tcp udp; do
  owner="$(port_owner "$LISTENING_PORT" "$proto")"
  if [ -n "$owner" ]; then
    # coturn re-running this script is not a conflict; anybody else is.
    if echo "$owner" | grep -q "turnserver"; then
      log "  ${LISTENING_PORT}/${proto} already held by coturn -- this is a re-run, fine"
    else
      warn "  ${LISTENING_PORT}/${proto} is already held by: $owner"
      CONFLICT=1
    fi
  fi
done
# The relay range must be genuinely free. Something already listening inside it
# would have its traffic stolen the moment coturn allocated that port.
BUSY_IN_RANGE="$(ss -H -lntu 2>/dev/null | awk '{print $5}' | sed 's/.*://' \
  | awk -v lo="$MIN_RELAY_PORT" -v hi="$MAX_RELAY_PORT" '$1+0>=lo && $1+0<=hi' | sort -un | tr '\n' ' ')"
if [ -n "$(echo "$BUSY_IN_RANGE" | tr -d ' ')" ]; then
  warn "  ports already listening inside the relay range ${MIN_RELAY_PORT}-${MAX_RELAY_PORT}: $BUSY_IN_RANGE"
  CONFLICT=1
fi
if [ "$CONFLICT" = "1" ] && [ "$FORCE" != "1" ]; then
  die "refusing to install: something else already owns a port this relay needs.
       Move the relay to another port, pick another host, or re-run with --force
       once you know what that process is and that losing its port is acceptable."
fi

# --- The address clients will actually reach. ---------------------------------
#
# THIS IS THE FIELD THAT IS MOST OFTEN WRONG. coturn hands out its relay address
# inside the ALLOCATE response, and it hands out whatever it BOUND unless told
# otherwise. On a host whose interface holds a private address behind a public
# one -- a cloud NAT, a floating IP -- binding is private and clients are told
# to send media to an address that does not exist on the internet. Allocations
# then succeed and no audio ever arrives, which is the hardest failure of the
# lot to diagnose. Hence `external-ip=PUBLIC/PRIVATE` when the two differ.
PRIMARY_IF="$(ip -4 route show default 2>/dev/null | awk '{print $5; exit}')"
BOUND_IP="$(ip -4 -o addr show dev "${PRIMARY_IF:-lo}" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
[ -n "$BOUND_IP" ] || die "could not determine this host's primary IPv4 address"

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$BOUND_IP"
  case "$BOUND_IP" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|169.254.*|127.*)
      die "the primary interface holds a PRIVATE address ($BOUND_IP), so the public
           address cannot be inferred. Pass it explicitly:
             sudo bash $0 --public-ip <the address clients reach>" ;;
  esac
fi
log "  interface ${PRIMARY_IF}: bound ${BOUND_IP}, advertised ${PUBLIC_IP}"

if [ "$PUBLIC_IP" = "$BOUND_IP" ]; then
  EXTERNAL_IP_LINE="external-ip=${PUBLIC_IP}"
else
  EXTERNAL_IP_LINE="external-ip=${PUBLIC_IP}/${BOUND_IP}"
fi

# ==============================================================================
# STAGE 1 -- INSTALL THE PACKAGE
# ==============================================================================

log "stage 1: package"

if dpkg -s coturn >/dev/null 2>&1; then
  log "  coturn already installed -- idempotent, nothing to do"
else
  run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn
fi

# Ubuntu ships coturn masked-by-default via this flag. Without it the unit
# starts and immediately exits 0, which reads as success everywhere.
if [ -f "$DEFAULTS" ] && grep -q '^#\?TURNSERVER_ENABLED' "$DEFAULTS"; then
  if grep -q '^TURNSERVER_ENABLED=1' "$DEFAULTS"; then
    log "  $DEFAULTS already enables the daemon"
  else
    run cp -a "$DEFAULTS" "${DEFAULTS}.bak.${STAMP}"
    run sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$DEFAULTS"
    log "  enabled TURNSERVER_ENABLED in $DEFAULTS (backup: ${DEFAULTS}.bak.${STAMP})"
  fi
fi

# ==============================================================================
# STAGE 2 -- THE SECRET
# ==============================================================================
#
# GENERATED HERE, ON THIS HOST, AT INSTALL TIME. It is never in this file, never
# in the repository, and never in a commit. That is the whole point: a secret
# committed anywhere is a secret that has to be rotated the moment anybody reads
# the history.
#
# Re-running the script REUSES an existing secret rather than minting a new one.
# Rotating silently would invalidate every credential the engine has already
# handed out and kill voice for everyone currently in a room. Rotation is a
# deliberate, documented procedure -- see docs/voice-turn-relay.md.

log "stage 2: static-auth-secret"

if [ -s "$SECRET_FILE" ]; then
  log "  reusing the existing secret at $SECRET_FILE (rotation is a separate, deliberate step)"
  SECRET="$(cat "$SECRET_FILE")"
elif [ "$DRY_RUN" = "1" ]; then
  log "  [dry-run] would generate a 48-byte secret into $SECRET_FILE"
  SECRET="DRY-RUN-PLACEHOLDER-NOT-A-SECRET"
else
  # 48 bytes of kernel entropy, base64. Far past what an HMAC-SHA1 key needs.
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  umask 077
  printf '%s' "$SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  log "  generated a new secret into $SECRET_FILE (mode 600, root only)"
fi

# ==============================================================================
# STAGE 3 -- THE CONFIGURATION
# ==============================================================================
#
# Every hardening line below is annotated with what it prevents. On a SHARED
# host the deny list is the most important block in the file, so read that one
# even if you skim the rest.

log "stage 3: $CONF"

NEW_CONF="$(mktemp)"
cat > "$NEW_CONF" <<EOF
# Managed by scripts/install-turn-relay.sh in the club-arena repository.
# Generated ${STAMP}. Hand edits are fine but will be overwritten on re-run;
# put lasting changes in the script so the two cannot drift.

# --- Identity and listeners --------------------------------------------------
realm=${REALM}
server-name=${REALM}
listening-port=${LISTENING_PORT}
listening-ip=${BOUND_IP}
# The address handed to clients in the ALLOCATE response. If this is wrong,
# allocations succeed and no audio ever arrives.
${EXTERNAL_IP_LINE}

# No TCP ALLOCATIONS (RFC 6062). This is the classic "somebody found your TURN
# server and is using it as a general-purpose TCP proxy" vector, and WebRTC has
# no use for it -- browsers only ever ask for UDP allocations. Note this does
# NOT stop a client CONNECTING over TCP: turn:...?transport=tcp still works,
# because that is the client-to-relay leg and it is served by listening on
# ${LISTENING_PORT}/tcp above. Players on networks that block UDP outright keep
# their path; the proxy abuse does not.
no-tcp-relay

# TURNS (TLS, 5349) is deliberately NOT configured here. It would need a
# certificate on a host whose Caddy already serves the co-tenant's sites, which
# is a change to their TLS setup, and it buys little: WebRTC media is already
# DTLS-SRTP end to end, so the relay forwards ciphertext it cannot read either
# way. The only thing TLS would hide is the fact that a TURN connection exists.
# See docs/voice-turn-relay.md if a network that blocks non-443 traffic ever
# makes it necessary.

# --- Authentication ----------------------------------------------------------
# The coturn REST scheme (draft-uberti-behave-turn-rest-00). The engine mints
#   username   = <unix-expiry>:<userId>
#   credential = base64(HMAC-SHA1(username, static-auth-secret))
# and coturn recomputes the same HMAC from the username it is handed. No user
# records exist on this box, and every credential expires on its own.
use-auth-secret
static-auth-secret=${SECRET}

# --- Relay port range --------------------------------------------------------
# See the arithmetic in the script header: 4096 ports is roughly 28 concurrent
# nine-handed voice tables. Raise this and the firewall rule together.
min-port=${MIN_RELAY_PORT}
max-port=${MAX_RELAY_PORT}

# --- Quotas ------------------------------------------------------------------
# What makes a leaked credential worth almost nothing, and what stops a busy
# night starving the co-tenant's traffic on a shared NIC.
user-quota=${USER_QUOTA_KBPS}
total-quota=${TOTAL_QUOTA_KBPS}
# The longest lifetime coturn will grant one allocation before the client has
# to refresh it. Browsers refresh well inside this. Capping it means an
# abandoned allocation -- a tab closed mid-hand, a phone that went into a tunnel
# -- releases its port within the hour instead of holding it.
max-allocate-lifetime=3600
# How long a nonce stays valid. Forces periodic re-authentication, so a
# credential that has expired stops working on the NEXT nonce rather than
# whenever the client happens to reconnect.
stale-nonce=600

# --- Hardening ---------------------------------------------------------------
# No telnet/CLI listener. coturn's CLI has historically shipped with a default
# password and it listens on 5766. There is no reason for it to exist here.
no-cli
# No multicast peers. A relay that will forward to a multicast group is an
# amplifier pointed at somebody else's network.
no-multicast-peers
# Message-integrity fingerprinting, as WebRTC clients expect.
fingerprint
# Long-term credential mechanism (what use-auth-secret rides on). Anonymous
# allocations are refused outright.
lt-cred-mech
# Refuse loopback relaying: without this a credential holder can reach services
# bound to 127.0.0.1 on THIS box -- which on a co-tenanted host is the
# neighbour's admin interfaces, the metrics stack, and the engine itself.
no-loopback-peers

# --- THE DENY LIST: the single most important block on a shared host ---------
#
# A TURN relay's job is to forward packets to wherever the client asks. Left
# open, "wherever" includes this machine's own private network and everything
# on it. On a box that also runs an unrelated business plus Prometheus,
# Grafana, Alertmanager, Caddy and the Club Arena engine, an unrestricted relay
# is a credentialled tunnel straight into all of them, and the traffic arrives
# from 127.0.0.1 so nothing upstream sees it as external.
#
# Deny everything private first, then allow nothing back. There is no
# allowed-peer-ip line in this file on purpose: voice peers are public
# addresses, and any exception belongs in a review, not in a default.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=::ffff:0.0.0.0-::ffff:255.255.255.255
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# --- Logging -----------------------------------------------------------------
# To syslog, which on this host is journald: it rotates with everything else
# and cannot fill the disk the co-tenant is also using. coturn's own log-file
# rotation is its own scheme and has filled disks before.
#
# The "verbose" option is deliberately NOT set. Verbose coturn logs every
# allocation with
# its username, and a REST username is "<expiry>:<userId>" -- so verbose mode
# writes a per-player activity log to disk. Turn it on for a debugging session,
# turn it off again, and say so in the incident notes.
syslog
simple-log
EOF

if [ -f "$CONF" ] && cmp -s "$NEW_CONF" "$CONF"; then
  log "  $CONF is already exactly this -- nothing to write"
  CONF_CHANGED=0
else
  if [ -f "$CONF" ]; then
    run cp -a "$CONF" "${CONF}.bak.${STAMP}"
    log "  existing config backed up to ${CONF}.bak.${STAMP}"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would write $CONF:"
    sed 's/^static-auth-secret=.*/static-auth-secret=<REDACTED>/' "$NEW_CONF" | sed 's/^/[dry-run]   /'
  else
    install -o root -g root -m 0640 "$NEW_CONF" "$CONF"
    # coturn drops to the `turnserver` user and must still read its own config.
    if getent group turnserver >/dev/null 2>&1; then
      chgrp turnserver "$CONF"
    fi
  fi
  CONF_CHANGED=1
fi
rm -f "$NEW_CONF"

# ==============================================================================
# STAGE 4 -- FIREWALL: ADD ONLY
# ==============================================================================
#
# ADD RULES, NEVER REMOVE OR REORDER ONE. The co-tenant's rules are on this same
# firewall. There is no `ufw reset`, no `iptables -F`, no `--flush`, and no
# rule numbering here, and there must never be.

log "stage 4: firewall (adding rules only)"

FW_ROLLBACK=""
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "active"; then
  log "  ufw is active -- adding allow rules"
  # ufw allow is idempotent: a duplicate is a no-op with a "Skipping" notice.
  run ufw allow "${LISTENING_PORT}/udp" comment "club-arena TURN"
  run ufw allow "${LISTENING_PORT}/tcp" comment "club-arena TURN"
  run ufw allow "${MIN_RELAY_PORT}:${MAX_RELAY_PORT}/udp" comment "club-arena TURN relay range"
  FW_ROLLBACK="ufw delete allow ${LISTENING_PORT}/udp; ufw delete allow ${LISTENING_PORT}/tcp; ufw delete allow ${MIN_RELAY_PORT}:${MAX_RELAY_PORT}/udp"
elif command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | grep -q 'table inet'; then
  # A raw nftables ruleset is almost always managed by something else (docker,
  # a config-management tool, the co-tenant's own scripts). Editing it blind is
  # exactly the class of change that takes a neighbour down.
  warn "  nftables is in use and is not managed by ufw. Rules are NOT being added"
  warn "  automatically -- adding them blind risks the co-tenant's ruleset."
  warn "  Add these by hand, in whatever manages that ruleset:"
  warn "    udp dport ${LISTENING_PORT} accept"
  warn "    tcp dport ${LISTENING_PORT} accept"
  warn "    udp dport ${MIN_RELAY_PORT}-${MAX_RELAY_PORT} accept"
else
  log "  no active ufw and no nftables ruleset found -- assuming the provider"
  log "  firewall is upstream. Open there: ${LISTENING_PORT}/udp, ${LISTENING_PORT}/tcp,"
  log "  ${MIN_RELAY_PORT}-${MAX_RELAY_PORT}/udp"
fi

# ==============================================================================
# STAGE 5 -- ENABLE AND START
# ==============================================================================

log "stage 5: systemd"

run systemctl enable coturn        # survives reboot
if systemctl is-active --quiet coturn 2>/dev/null; then
  if [ "${CONF_CHANGED:-0}" = "1" ]; then
    log "  config changed -- restarting coturn"
    run systemctl restart coturn
  else
    log "  coturn already running with this exact config -- not restarting"
  fi
else
  run systemctl start coturn
fi

if [ "$DRY_RUN" != "1" ]; then
  sleep 2
  systemctl is-active --quiet coturn \
    || die "coturn did not stay running. journalctl -u coturn -n 50 --no-pager"
  log "  coturn is active"
fi

# ==============================================================================
# STAGE 6 -- PROVE WE DISTURBED NOTHING
# ==============================================================================

log "stage 6: neighbour check"

if [ "$DRY_RUN" != "1" ]; then
  POST_RUNNING="$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null \
    | awk '{print $1}' | sort || true)"
  STOPPED="$(comm -23 <(echo "$PRE_RUNNING") <(echo "$POST_RUNNING") | tr '\n' ' ')"
  if [ -n "$(echo "$STOPPED" | tr -d ' ')" ]; then
    warn "  services that were running before and are NOT now: $STOPPED"
    warn "  THIS INSTALL DISTURBED SOMETHING. Roll back (commands below) and investigate."
  else
    log "  every service that was running before this change is still running"
  fi
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx club-arena-engine; then
    log "  club-arena-engine container still up"
  fi
fi

# ==============================================================================
# STAGE 7 -- VERIFY BY ACTUALLY ALLOCATING
# ==============================================================================
#
# A PORT CHECK IS NOT A VERIFICATION. "Something is listening on 3478" is true
# of a coturn that refuses every credential, of a coturn whose external-ip is
# wrong, and of a completely unrelated process. The only check worth printing at
# the end of an install is one that mints a REAL credential with the REAL secret
# and asks the relay for a REAL allocation.

log "stage 7: allocation check"

if [ "$DRY_RUN" = "1" ]; then
  log "  [dry-run] would mint a 10-minute credential and run turnutils_uclient"
elif ! command -v turnutils_uclient >/dev/null 2>&1; then
  warn "  turnutils_uclient not found (it ships in the coturn package)."
  warn "  The relay is NOT verified. Install it and re-run this stage by hand."
else
  EXPIRY=$(( $(date +%s) + 600 ))
  TEST_USER="${EXPIRY}:install-check"
  # The exact derivation the engine performs in
  # server/src/voice/turnCredentials.ts. If these two ever disagree, this check
  # fails here rather than as "voice is broken" a week later.
  TEST_PASS="$(printf '%s' "$TEST_USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)"

  log "  requesting a real allocation as ${TEST_USER%%:*}:install-check ..."
  ALLOC_OUT="$(turnutils_uclient -T -n 1 -c -y -u "$TEST_USER" -w "$TEST_PASS" \
      -p "$LISTENING_PORT" "$PUBLIC_IP" 2>&1 || true)"

  if echo "$ALLOC_OUT" | grep -Eqi 'success|allocate.*(granted|response)|total transmit'; then
    log "  ALLOCATION GRANTED -- the relay is answering real credentials."
  else
    warn "  ALLOCATION WAS NOT GRANTED. The relay is installed but NOT working."
    warn "  Most likely causes, in the order they actually happen:"
    warn "    1. the firewall (provider-side as well as host-side) is not open"
    warn "    2. external-ip is wrong -- it must be the address CLIENTS reach"
    warn "    3. the engine's TURN_STATIC_AUTH_SECRET does not match this host's"
    warn "  Output follows:"
    echo "$ALLOC_OUT" | sed 's/^/      /' >&2
  fi
fi

# ==============================================================================
# STAGE 8 -- STAGE THE SECRET FOR THE ENGINE (does not deploy anything)
# ==============================================================================

log "stage 8: engine environment"

if [ "$WRITE_ENGINE_ENV" = "1" ]; then
  if [ ! -f "$ENGINE_ENV" ]; then
    warn "  $ENGINE_ENV does not exist on this host -- nothing written."
  elif grep -q '^TURN_STATIC_AUTH_SECRET=' "$ENGINE_ENV" 2>/dev/null; then
    log "  $ENGINE_ENV already carries TURN_STATIC_AUTH_SECRET -- left untouched."
    log "  If it is stale, edit it by hand; this script will not overwrite a live secret."
  else
    run cp -a "$ENGINE_ENV" "${ENGINE_ENV}.bak.${STAMP}"
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] would append TURN_STATIC_AUTH_SECRET / TURN_HOST to $ENGINE_ENV"
    else
      {
        echo ""
        echo "# Table voice TURN relay -- added by install-turn-relay.sh ${STAMP}"
        echo "TURN_STATIC_AUTH_SECRET=${SECRET}"
        echo "TURN_HOST=${PUBLIC_IP}"
        echo "TURN_PORT=${LISTENING_PORT}"
      } >> "$ENGINE_ENV"
    fi
    log "  appended TURN_* to $ENGINE_ENV (backup: ${ENGINE_ENV}.bak.${STAMP})"
  fi
  log ""
  log "  NOTHING WAS RESTARTED. The running engine still has the OLD environment,"
  log "  so it will keep answering /voice/ice with the STUN-only list until the"
  log "  container is recreated. That is deliberate: a restart voids in-flight"
  log "  hands. The next natural deploy of server/** picks it up."
else
  log "  not writing the engine env (pass --write-engine-env to stage it)."
  log "  The engine needs, in ${ENGINE_ENV}:"
  log "    TURN_STATIC_AUTH_SECRET=<contents of ${SECRET_FILE}>"
  log "    TURN_HOST=${PUBLIC_IP}"
  log "    TURN_PORT=${LISTENING_PORT}"
fi

# ==============================================================================
# DONE -- and here is how to undo all of it
# ==============================================================================

echo ""
log "============================================================"
log " DONE. Relay: ${PUBLIC_IP}:${LISTENING_PORT}, realm ${REALM}"
log " Relay ports: ${MIN_RELAY_PORT}-${MAX_RELAY_PORT}/udp"
log " Secret file: ${SECRET_FILE} (mode 600)"
if [ "$PRINT_SECRET" = "1" ] && [ "$DRY_RUN" != "1" ]; then
  log " Secret: ${SECRET}"
else
  log " Secret NOT printed. Read it with: cat ${SECRET_FILE}"
fi
log "============================================================"
echo ""
log "ROLLBACK -- removes the relay and leaves every neighbour untouched:"
cat <<ROLLBACK

  systemctl stop coturn
  systemctl disable coturn
$( [ -n "$FW_ROLLBACK" ] && echo "  ${FW_ROLLBACK}" )
  # restore the previous config, if there was one:
  ls -1 ${CONF}.bak.* 2>/dev/null | tail -1 | xargs -r -I{} cp -a {} ${CONF}
  # or remove the package outright:
  apt-get remove --purge -y coturn
  rm -f ${SECRET_FILE}
  # and take the secret back out of the engine env (then let the NEXT natural
  # deploy pick that up -- do not restart the engine by hand under live hands):
  sed -i '/^TURN_STATIC_AUTH_SECRET=/d;/^TURN_HOST=/d;/^TURN_PORT=/d' ${ENGINE_ENV}

  With the secret gone, GET /voice/ice answers the STUN-only list again and
  voice returns to exactly the behaviour it shipped with. Nothing breaks.

ROLLBACK
