#!/usr/bin/env bash
# Deploy the Club Arena static origin's Caddy config.
#
# The origin (ca-static.smarter.poker) is a Caddy on the Hetzner box
# estate-ci-1 serving /srv/club-arena. Until this file existed the config
# lived ONLY on that box: rebuild the box and the arrangement is gone, with
# nothing in git to say what it was. Now the file beside this script is the
# truth and this pushes it.
#
#   bash infra/ca-origin/deploy-origin-config.sh            # deploy + verify
#   DRY_RUN=1 bash infra/ca-origin/deploy-origin-config.sh  # diff only
#
# RESTART, not reload, when the running Caddy has lost its PrivateTmp - the
# nightly GC used to delete /tmp out from under it (fixed 2026-09-03, but a
# box provisioned before that fix still bites). A restart of this service is
# ~200ms and drops no connection that matters: every response is a static file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY="${CA_ORIGIN_SSH_KEY_PATH:-$HOME/.ssh/hetzner_deploy}"
HOST="${CA_ORIGIN_HOST:-$(security find-generic-password -a smarter-poker -s estate-ci-ip -w 2>/dev/null || true)}"
[ -n "$HOST" ] || { echo "no origin host (set CA_ORIGIN_HOST, or add estate-ci-ip to the keychain)"; exit 1; }
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=25 root@$HOST"

echo "[origin] target $HOST"
REMOTE=$($SSH 'cat /etc/caddy/Caddyfile 2>/dev/null' || true)
if [ "$REMOTE" = "$(cat "$HERE/Caddyfile")" ]; then
  echo "[origin] already in sync."
else
  diff <(printf '%s\n' "$REMOTE") "$HERE/Caddyfile" | head -40 || true
  [ "${DRY_RUN:-0}" = "1" ] && { echo "[origin] dry run, nothing sent."; exit 0; }
  # VALIDATE BEFORE OVERWRITING, not after. The previous order scp'd straight
  # onto /etc/caddy/Caddyfile and validated afterwards, so a bad config left a
  # broken file on disk and only exited 2. The running Caddy survives on its
  # in-memory config, which makes it look survivable - but the next reload,
  # restart or reboot then serves nothing, and this origin is now in front of
  # every Club Arena page load. Stage it, validate the staged copy, and only
  # then move it into place.
  scp -q -i "$KEY" "$HERE/Caddyfile" "root@$HOST:/etc/caddy/Caddyfile.staged"
  $SSH 'caddy validate --config /etc/caddy/Caddyfile.staged >/dev/null 2>&1' || {
    echo "[origin] REFUSING: the config does not validate on the box. The live"
    echo "[origin] Caddyfile is UNTOUCHED; the rejected copy is at"
    echo "[origin] /etc/caddy/Caddyfile.staged if you want to look at it."
    exit 2
  }
  # Keep the outgoing config so a bad-but-valid change can be undone by hand.
  $SSH 'cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev 2>/dev/null || true
        mv -f /etc/caddy/Caddyfile.staged /etc/caddy/Caddyfile'
  $SSH 'systemctl reload caddy || systemctl restart caddy' || {
    echo "[origin] reload FAILED after a valid config - rolling back."
    $SSH 'cp -a /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile && (systemctl reload caddy || systemctl restart caddy)'
    exit 4
  }
fi

# Verify against the public hostname, not the box: that is what a player hits.
for path in /build-info.json /index.html; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://ca-static.smarter.poker$path")
  [ "$code" = "200" ] || { echo "[origin] FAILED: $path answered $code"; exit 3; }
done
echo "[origin] serving: $(curl -s --max-time 15 https://ca-static.smarter.poker/build-info.json | sed -n 's/.*"ca_sha"[^"]*"\([^"]*\)".*/\1/p' | cut -c1-9)"
