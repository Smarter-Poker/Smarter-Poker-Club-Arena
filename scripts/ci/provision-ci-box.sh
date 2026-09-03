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
#                    2 workers and node at a 3 GB heap. Uncapped, eight
#                    concurrent vitest runs forked a worker per core (64 on 8
#                    cores, load 69-75 measured) and every job was starved.
#   4. sweeper     - applies a changed drop-in to busy runners as they go idle,
#                    never killing a job; removes itself when done.
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
VITEST_WORKERS="${VITEST_WORKERS:-4}"
NODE_HEAP_MB="${NODE_HEAP_MB:-3072}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.58.0}"

say() { printf '\n== %s\n' "$*"; }

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
  rm -rf /tmp/* 2>/dev/null
  command -v docker >/dev/null && docker system prune -af --filter "until=72h" >/dev/null 2>&1
  su - ci -c "npm cache verify" >/dev/null 2>&1
  echo "    after: $(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
} >> $LOG 2>&1
tail -c 200000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
EOF
chmod +x /usr/local/bin/ci-gc.sh
( crontab -l 2>/dev/null | grep -v ci-gc.sh; echo "17 4 * * * /usr/local/bin/ci-gc.sh" ) | crontab -
echo "   cron: $(crontab -l | grep -c ci-gc.sh) entry"

# ── 3. fair-share drop-in on every runner unit ───────────────────────────────
say "fair-share drop-ins (VITEST_MAX_WORKERS=${VITEST_WORKERS}, heap ${NODE_HEAP_MB} MB)"
UNITS=$(systemctl list-units 'actions.runner.*' --all --no-legend | awk '{print $1}')
n=0
for svc in $UNITS; do
  mkdir -p "/etc/systemd/system/$svc.d"
  cat > "/etc/systemd/system/$svc.d/10-fair-share.conf" <<EOF
# Managed by scripts/ci/provision-ci-box.sh - edit there, not here.
# vitest 4 reads VITEST_MAX_WORKERS (verified against the installed package).
[Service]
Environment=VITEST_MAX_WORKERS=${VITEST_WORKERS}
Environment=NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}
EOF
  n=$((n+1))
done
systemctl daemon-reload
echo "   drop-ins written: $n"

# ── 4. idle sweeper: apply the drop-in without killing a job ─────────────────
say "idle-restart sweeper"
cat > /usr/local/bin/ci-restart-idle-runners.sh <<'EOF'
#!/bin/bash
# A runner is mid-job iff a Runner.Worker lives under its directory. Restart
# only the others, so a changed unit takes effect with zero jobs lost. Removes
# itself from cron once every runner has restarted since the stamp.
MARK=/var/lib/ci-runner-env.stamp; [ -f $MARK ] || touch $MARK
left=0
for d in /home/ci/actions-runner-*; do
  name=$(basename "$d" | sed 's/actions-runner-//')
  svc=$(systemctl list-units 'actions.runner.*' --no-legend | awk '{print $1}' | grep "\.${name}\.service$" | head -1)
  [ -n "$svc" ] || continue
  since=$(systemctl show -p ActiveEnterTimestamp --value "$svc" | xargs -I{} date -d {} +%s 2>/dev/null || echo 0)
  [ "$since" -gt "$(stat -c %Y $MARK)" ] && continue
  if pgrep -f "$d/bin/Runner.Worker" >/dev/null; then left=$((left+1)); continue; fi
  systemctl restart "$svc" && echo "$(date -u +%FT%TZ) restarted idle $name" >> /var/log/ci-runner-env.log
done
[ $left -eq 0 ] && { crontab -l | grep -v ci-restart-idle-runners | crontab -; echo "$(date -u +%FT%TZ) all runners on new env; sweeper removed" >> /var/log/ci-runner-env.log; }
EOF
chmod +x /usr/local/bin/ci-restart-idle-runners.sh
touch /var/lib/ci-runner-env.stamp
( crontab -l 2>/dev/null | grep -v ci-restart-idle; echo "*/5 * * * * /usr/local/bin/ci-restart-idle-runners.sh" ) | crontab -
/usr/local/bin/ci-restart-idle-runners.sh || true
echo "   armed; restarted idle runners now, busy ones roll over within 5 min"

# ── 5. tools ─────────────────────────────────────────────────────────────────
say "tools"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/ns.sh && bash /tmp/ns.sh >/dev/null && apt-get install -y -qq nodejs >/dev/null
fi
# jq for the watchdogs; psql because post-deploy-e2e certifies the cashier
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
npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium webkit >/tmp/pwdeps.log 2>&1 && echo "   ok" || { echo "   FAILED - see /tmp/pwdeps.log"; tail -3 /tmp/pwdeps.log; }

say "done"
echo "   cores $(nproc) | mem $(free -g | awk '/Mem:/{print $2}')G | swap $(free -g | awk '/Swap:/{print $2}')G | disk $(df -h / | awk 'NR==2{print $4}') free"
