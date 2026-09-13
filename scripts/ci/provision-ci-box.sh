#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# provision-ci-box.sh — everything the estate CI box needs BESIDES the runner
# processes themselves. Idempotent. Run as root on the box. Re-run any time.
#
# Written 2026-09-02 after the box was tuned by hand under load and nothing
# about that tuning existed anywhere but on its disk. A box that cannot be
# rebuilt from the repo is a single point of failure wearing a cost saving.
#
#   estate-ci-1  cpx41  8 vCPU / 16 GB  Ashburn   (resized from cpx31 2026-09-02)
#
# setup-selfhosted-runner.sh registers each runner process. This script makes
# the BOX fit to run eight of them at once:
#
#   1. swap        - 8 GB. A memory spike can no longer OOM-kill a job.
#   2. GC          - nightly. Hosted runners throw their disk away after every
#                    run; a persistent one does not, so without this the box
#                    fills and every CI job on the estate fails at once.
#   3. fair share  - a systemd drop-in on EVERY runner unit capping vitest at
#                    a DERIVED worker cap and node at a 3 GB heap. Uncapped,
#                    eight concurrent vitest runs forked a worker per core (64
#                    on 8 cores, load 69-75 measured) and every job starved.
#                    A fixed cap of 4 starved them again at load 44 (see the
#                    note above the derivation); the cap now follows the box.
#   4. activation  - applies changed drop-ins once, during this explicit
#                    provision run, and refuses to touch any busy runner.
#   5. browsers    - chromium + webkit system libraries, installed once, so
#                    Playwright jobs never apt-get on the box.
#   6. tools       - node, gh, jq. gh is what the publisher's convergence chain
#                    shells out to; a routed job that needs it must find it.
#
# THE ONE THING TO GET RIGHT: vitest 4 reads VITEST_MAX_WORKERS. Not
# VITEST_MAX_THREADS, not VITEST_MAX_FORKS. The first cut of this tuning set
# the wrong variable and did nothing; that was caught by grepping the
# installed package for which VITEST_* names it actually contains, and then by
# counting a live vitest process's children (8 uncapped, 3 capped). Do not
# "modernise" the variable name without repeating that check.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

SWAP_GB="${SWAP_GB:-8}"
# VITEST_WORKERS is DERIVED below, once the runner count is known. Setting it
# here would be the bug this replaced: a constant tuned for one job on an
# idle box, applied to ten runners at once. Export it to override.
NODE_HEAP_MB="${NODE_HEAP_MB:-3072}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.58.0}"

say() { printf '\n== %s\n' "$*"; }

# ── cron_set KEY LINE: install LINE as the one entry containing KEY ──────────
# Written after this script WIPED the box crontab on its second run.
#
# The obvious idiom, ( crontab -l | grep -v KEY; echo LINE ) | crontab -, is a
# trap under `set -e -o pipefail`: when KEY is the ONLY entry, `grep -v` matches
# nothing and exits 1, the subshell aborts before the echo, and `crontab -`
# receives an empty document. The nightly GC vanished and the script died with
# no "done" line. It had worked on the first run only because a second entry
# happened to exist. A helper that reads, edits in a variable, writes, and then
# READS BACK is not clever; it is the only shape that cannot lose the table.
cron_set() {
  local key="$1" line="$2" cur new
  cur=$(crontab -l 2>/dev/null || true)
  new=$(printf '%s\n' "$cur" | grep -v -- "$key" || true)
  printf '%s\n%s\n' "$new" "$line" | sed '/^$/d' | crontab -
  crontab -l | grep -qF -- "$line" || { echo "   FATAL: crontab write for $key did not stick"; exit 1; }
}
cron_del() {
  local key="$1" cur new
  cur=$(crontab -l 2>/dev/null || true)
  new=$(printf '%s\n' "$cur" | grep -v -- "$key" || true)
  printf '%s\n' "$new" | sed '/^$/d' | crontab -
  if crontab -l 2>/dev/null | grep -q -- "$key"; then
    echo "   FATAL: crontab retirement for $key did not stick"
    exit 1
  fi
}

# ── 1. swap ──────────────────────────────────────────────────────────────────
say "swap (${SWAP_GB} GB)"
if ! swapon --show --noheadings | grep -q '^/swapfile'; then
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 >/dev/null
grep -q 'vm.swappiness' /etc/sysctl.d/90-ci.conf 2>/dev/null || echo 'vm.swappiness=10' > /etc/sysctl.d/90-ci.conf
swapon --show --noheadings | awk '{print "   active:",$1,$3}'

# ── 2. nightly GC ────────────────────────────────────────────────────────────
say "nightly GC"
cat > /usr/local/bin/ci-gc.sh <<'EOF'
#!/bin/bash
# Keeps caches (that is the whole speed win); removes only what is dead.
set -u
LOG=/var/log/ci-gc.log
{
  echo "=== $(date -u +%FT%TZ) before: $(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
  find /home/ci/actions-runner-*/_work -maxdepth 2 -type d -mtime +3 \
       -not -name "_work" -not -name "_temp" -not -name "_actions" -not -name "_tool" \
       -exec rm -rf {} + 2>/dev/null
  find /home/ci/actions-runner-*/_work/_temp -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null
  find /home/ci/actions-runner-*/_diag -type f -mtime +7 -delete 2>/dev/null
  # NOT `rm -rf /tmp/*` (2026-09-03). That deletes the systemd PrivateTmp
  # namespace of every RUNNING service - caddy on the origin box could not
  # reload at all until it was restarted, because its /tmp had been pulled out
  # from under it at 04:17 - and it deletes the scratch files of any CI job in
  # flight at that minute, which is a random red build nobody can reproduce.
  # Age it instead, and never touch the namespaces or the socket dirs.
  find /tmp -mindepth 1 -maxdepth 1 -mtime +1 \
       ! -name "systemd-private-*" ! -name ".X11-unix" ! -name ".ICE-unix" \
       -exec rm -rf {} + 2>/dev/null
  command -v docker >/dev/null && docker system prune -af --filter "until=72h" >/dev/null 2>&1
  su - ci -c "npm cache verify" >/dev/null 2>&1
  echo "    after: $(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
} >> $LOG 2>&1
tail -c 200000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
EOF
chmod +x /usr/local/bin/ci-gc.sh
cron_set ci-gc.sh "17 4 * * * /usr/local/bin/ci-gc.sh"
echo "   cron: $(crontab -l | grep -c ci-gc.sh) entry (verified)"

# ── 3. fair-share drop-in on every runner unit ───────────────────────────────
#
# THE CAP IS DERIVED FROM THE BOX, NOT TYPED IN. This was `${VITEST_WORKERS:-4}`
# and the 4 was measured honestly - one job, idle box, 12.9 min down to 3.1.
# It was never measured against the case that actually happens: on 2026-09-02
# NINE jobs ran at once, each entitled to 4 workers, and 26 vitest processes
# fought over 8 cores at load 44. Jobs did not merely slow down, they FAILED -
# a 150-hand simulation that takes 967 ms on a laptop measured 12342 ms and
# blew a 10 s ceiling, turning main red and stopping the publisher. A queued
# job waits harmlessly; a starved job times out. Fewer workers is therefore
# not just cheaper, it is more correct.
#
# So: total workers across every runner is held near 2x cores, and the
# per-runner share falls out of that. A resize fixes the cap by itself.
# Floor 2, because 1 makes a lone job pointlessly serial. Ceiling 4, because
# that is the measured knee - past it a single job stops getting faster.
UNITS=$(systemctl list-units 'actions.runner.*' --all --no-legend | awk '{print $1}')
UNIT_N=$(printf '%s\n' "$UNITS" | grep -c . || true)
[ "${UNIT_N:-0}" -gt 0 ] || UNIT_N=1
DERIVED=$(( $(nproc) * 2 / UNIT_N ))
[ "$DERIVED" -lt 2 ] && DERIVED=2
[ "$DERIVED" -gt 4 ] && DERIVED=4
VITEST_WORKERS="${VITEST_WORKERS:-$DERIVED}"
say "fair-share drop-ins (VITEST_MAX_WORKERS=${VITEST_WORKERS}, heap ${NODE_HEAP_MB} MB)"
echo "   $(nproc) cores / $UNIT_N runners -> $VITEST_WORKERS workers each, $(( UNIT_N * VITEST_WORKERS )) peak"
n=0
for svc in $UNITS; do
  mkdir -p "/etc/systemd/system/$svc.d"
  cat > "/etc/systemd/system/$svc.d/10-fair-share.conf" <<EOF
# Managed by scripts/ci/provision-ci-box.sh - edit there, not here.
# vitest 4 reads VITEST_MAX_WORKERS (verified against the installed package).
[Service]
Environment=VITEST_MAX_WORKERS=${VITEST_WORKERS}
Environment=NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}
# RUNNER_ENVIRONMENT IS SET BY US BECAUSE THIS RUNNER BUILD DOES NOT SET IT.
# GitHub documents it as a default variable, so three test files already relax
# their wall clock with
#   10_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1)
# and every one of them was a silent no-op on this box: the string
# RUNNER_ENVIRONMENT appears ZERO times in Runner.Worker.dll and
# Runner.Common.dll of the installed runner (checked 2026-09-02), so the
# ternary always took the hosted branch ON the self-hosted box. The proof it
# left behind is a failure that reads "Test timed out in 10000ms" where a
# working multiplier would have said 30000ms. That one turned main red and
# stopped the publisher.
# Setting it here is not a lie - this IS a self-hosted runner - and nothing
# overrides it, precisely because the runner never writes the name at all.
# It repairs every existing user of the idiom and every future copy of it.
Environment=RUNNER_ENVIRONMENT=self-hosted
EOF
  n=$((n+1))
done
systemctl daemon-reload
echo "   drop-ins written: $n"

# ── 4. bounded activation: no cron, watcher, or later reconciler ─────────────
say "bounded runner configuration activation"

# Retire the old five-minute sweeper every time this provisioner is run. A
# configuration change must either take effect in this bounded invocation or
# fail visibly; it must not leave a background process waiting to mutate the
# machine later.
cron_del ci-restart-idle-runners
rm -f /usr/local/bin/ci-restart-idle-runners.sh

runner_busy() {
  local d="$1"
  pgrep -f "$d/bin/Runner.Worker" >/dev/null && return 0
  [ -n "$(find "$d/_work" -maxdepth 3 -newermt '-120 seconds' -print -quit 2>/dev/null)" ] && return 0
  return 1
}

assert_all_runners_idle() {
  local d busy=""
  for d in /home/ci/actions-runner-*; do
    [ -d "$d" ] || continue
    runner_busy "$d" && busy="$busy $(basename "$d")"
  done
  [ -z "$busy" ] || {
    echo "   FATAL: runner configuration is written but not activated; busy:$busy"
    echo "   Re-run this explicit provision command after those jobs finish."
    return 1
  }
}

# Check twice around a quiet interval. If a runner is working or has just
# accepted work, abort the whole activation before restarting anything.
assert_all_runners_idle
sleep 3
assert_all_runners_idle

for svc in $UNITS; do
  systemctl restart "$svc"
done
echo "   activated once on $n idle runner service(s); no retry job was installed"

# ── 5. tools ─────────────────────────────────────────────────────────────────
say "tools"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/ns.sh && bash /tmp/ns.sh >/dev/null && apt-get install -y -qq nodejs >/dev/null
fi
# jq for workflow evidence; psql because post-deploy-e2e certifies the cashier
# database contract with it and a hosted runner ships it preinstalled - the
# first routed run on this box failed with "psql: command not found" on a step
# that had never failed on hosted. Everything a routed workflow shells out to
# must be here, or moving the job is a regression dressed as a saving.
apt-get install -y -qq jq postgresql-client unzip zip >/dev/null 2>&1 || true
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq >/dev/null && apt-get install -y -qq gh >/dev/null
fi
printf '   node %s | gh %s | jq %s | psql %s\n' "$(node -v)" "$(gh --version | head -1 | awk '{print $3}')" "$(jq --version)" "$(psql --version | awk '{print $3}')"

# ── 5b. every binary a routed workflow shells out to must exist here ─────────
# A hosted runner ships hundreds of tools; this box ships what is installed.
# Scanning the workflows is the only way to know the set stays complete.
say "routed-workflow tool audit"
MISSING=""
for t in psql gh jq curl git node npm npx python3 ssh; do command -v "$t" >/dev/null || MISSING="$MISSING $t"; done
[ -z "$MISSING" ] && echo "   every CLI the workflows call is present" || { echo "   MISSING:$MISSING"; exit 1; }

# ── 6. browser system libraries (once; the binaries cache under ~ci) ─────────
say "playwright system deps (chromium + webkit)"
# DO NOT TRUST THE EXIT CODE HERE. `playwright install-deps` shells out to
# apt-get, which returns non-zero on a perfectly healthy box - held packages,
# "8 not upgraded", a warning on a repo it does not need. On 2026-09-02 this
# printed "FAILED - see /tmp/pwdeps.log" while the log said, in full,
# "0 upgraded, 0 newly installed, 0 to remove": every library was already
# present and both browsers ran fine. An operator chasing that non-problem is
# exactly the cost a false alarm has, and a provisioner that cries wolf is one
# people stop reading.
#
# So the install still runs, and then the RESULT is verified: every browser
# binary Playwright has unpacked must resolve all of its shared libraries.
# That is the thing we actually care about, it is what breaks a routed job,
# and it is true or false regardless of what apt felt about it.
npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium webkit >/tmp/pwdeps.log 2>&1 || true
PW_CACHE="${PW_CACHE:-/home/ci/.cache/ms-playwright}"
# A FRESH BOX HAS NO CACHE DIR YET (2026-09-03, estate-ci-3). `find` on a path
# that does not exist returns 1; under `set -o pipefail` that made the
# `missing=$(...)` assignment fail and `set -e` aborted the whole provisioner
# with exit 1 and no message, right after the "playwright system deps" header.
# The first two boxes never hit it because a Playwright job had already
# unpacked browsers there. Create the directory so the verify step has
# something to look at, and let a still-empty cache take the "no browsers
# unpacked yet" branch below as designed.
# OWN THE PARENT TOO. `install -d` creates missing parents as ROOT, so this
# line alone left /home/ci/.cache owned by root on a fresh box - and the ci
# user could then create nothing else in it. Measured 2026-09-03 on
# estate-ci-3: every World Hub `npm ci` failed in puppeteer's postinstall with
# `EACCES: permission denied, mkdir /home/ci/.cache/puppeteer`, which reads
# like a network problem and is not one.
install -d -o ci -g ci "$(dirname "$PW_CACHE")"
install -d -o ci -g ci "$PW_CACHE"
chown -R ci:ci "$(dirname "$PW_CACHE")" 2>/dev/null || true
missing=$(
  find "$PW_CACHE" -type f \( -name chrome -o -name headless_shell -o -name MiniBrowser \) 2>/dev/null |
  while read -r bin; do
    # `grep` exits 1 when NOTHING is missing - the healthy case - and under
    # `set -o pipefail` inside this `set -e` substitution that used to abort
    # the provisioner on a box whose browsers were fine (estate-ci-3,
    # 2026-09-03, second run). A miss is data here, not a failure.
    { ldd "$bin" 2>/dev/null | grep -F "not found" || true; } | sed "s|^|$(basename "$(dirname "$bin")")/$(basename "$bin"): |"
  done
)
bins=$(find "$PW_CACHE" -type f \( -name chrome -o -name headless_shell -o -name MiniBrowser \) 2>/dev/null | wc -l)
if [ -z "$missing" ] && [ "$bins" -gt 0 ]; then
  echo "   ok - $bins browser binary(ies), every shared library resolves"
elif [ "$bins" -eq 0 ]; then
  echo "   no browsers unpacked yet under $PW_CACHE - a Playwright job will install them on first run"
else
  echo "   FAILED - browser binaries are missing shared libraries:"; printf '%s\n' "$missing" | sed 's/^/     /' | head -20
fi

say "done"
echo "   cores $(nproc) | mem $(free -g | awk '/Mem:/{print $2}')G | swap $(free -g | awk '/Swap:/{print $2}')G | disk $(df -h / | awk 'NR==2{print $4}') free"
