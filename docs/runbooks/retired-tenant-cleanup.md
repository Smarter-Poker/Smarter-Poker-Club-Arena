# Retired tenant cleanup: reviewed scope, 2026-09-07

## Verified infrastructure

The host at `5.161.252.33`, currently named `pepnationrx`, runs the live
`club-arena-engine` container. Keep its address, SSH host keys, Caddy, Docker,
monitoring stack and poker data. Renaming this host does not mean replacing it.
The retired application directory `/opt/pepnationrx` and its systemd unit are
absent. nginx and certbot.timer are inactive; Caddy and Docker are active.

## Production changes prepared, not applied

The combined deletion and hostname-change command was rejected by automatic
approval review before execution. None of the changes below has been applied.

1. Capture a root-only rollback archive outside web roots, containing the root
   crontab, `/opt/deploy.sh`, the two legacy nginx sites, certificate directories,
   `/etc/hostname`, `/etc/hosts`, and existing cloud-init hostname settings.
   Record the Hetzner server ID/name and engine container ID/start time.
2. Remove only the three root cron entries targeting the missing application:
   billing-sweep at 01:00 UTC, payout-run at 02:00 UTC, refill-reminders at noon.
   Preserve any newly added unrelated cron entries. Re-read immediately before
   editing; abort if the recorded inventory has changed.
3. Remove the obsolete `/opt/deploy.sh` after rechecking it has no callers.
   Remove nginx sites `pepnationrx` and `api.pepnationrx.com` from sites-enabled
   and sites-available. Do not stop or reload Caddy or Docker.
4. Remove only certificate lineages `pepnationrx.com` and `api.pepnationrx.com`
   using Certbot, after verifying no active service references them. Preserve
   all other certificates and account registrations used by other services.
5. Rename the OS and Hetzner display name to `club-arena-engine`; update only
   the corresponding `/etc/hosts` aliases and preserve the hostname through
   cloud-init. Keep the IP, SSH key material and engine configuration intact.
6. Verify identical engine container ID/start time, healthy public HTTP,
   successful dedicated-probe table entry and reconnect, and monitoring target
   availability. Roll back affected configuration if any check fails.

## Repository cleanup still required

Club Arena has legacy references in shared estate automation, deployment
comments and historical documentation. `estate-integrity.sh` still lists
`PepNationLab`; the shared playbook still documents that product and its DB.
Shared guard files require coordinated PRs across the active repositories so
cleanup does not introduce guard drift. Remove the retired repo from active
estate scope; preserve the protections and required CI gates of active repos.
`install-turn-relay.sh` and `docs/voice-turn-relay.md` also describe obsolete
co-tenancy. Update their factual host inventory while preserving generic
service-continuity checks. Audit other repositories, Mac paths and cloud
projects separately before claiming estate-wide removal. Do not rewrite Git
history or destroy unrelated service credentials to remove historical names.

## Connection evidence and remaining limitations

SSH works through the authorized Mac. The engine was healthy and had memory
and disk headroom. Its Prometheus history showed p99 event-loop delay reaching
4,043 ms over six hours, so a healthy HTTP response is not proof of responsive
tables. Caddy recorded heartbeat 502/EOF responses and channel reconnect errors
around scheduled engine maintenance. These observations require correlation;
no causal attribution to the retired product has been established.

The next connection checks are sustained mux delivery, reconnect recovery,
authoritative snapshot recovery, and browser animation behavior. An isolated
successful socket observation does not complete the full live-game audit.
