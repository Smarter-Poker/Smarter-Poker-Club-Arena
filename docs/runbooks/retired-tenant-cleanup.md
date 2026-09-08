# Retired Tenant Cleanup, Applied 2026-09-07

The user explicitly approved the production cleanup after the initial automatic
review rejection. The scoped changes were applied at 21:37 UTC.

## Applied And Verified

- Removed three obsolete root cron jobs targeting the absent application:
  billing sweep, payout run, and refill reminders. Preserved unrelated entries.
- Removed the unused deployment script, two inactive nginx sites and their two
  certificate lineages. Caddy certificates and SSH host keys were preserved.
- Renamed the OS hostname and Hetzner display name to `club-arena-engine`.
  The network address remains unchanged. Cloud-init preserves the new hostname.
- Verified the engine container ID and start time were unchanged. No restart.
- Local and public engine health returned HTTP 200. Prometheus reported all
  four targets up: engine, host metrics, Prometheus, and TURN relay.

## Rollback

A root-only backup remains on the engine host, with the saved configuration,
crontab and engine identity. Its location is recorded in the local operation
output. The archive contains sensitive certificate material and must stay
outside web roots and Git.

If rollback is required, review the archive before restoring only affected
configuration. Restore the saved cron entries without replacing newer unrelated
jobs. Restore hostname/cloud-init settings together and use the Hetzner API to
restore its recorded display name. Do not restart the engine as part of rollback.

## Scope And Remaining Audit

Club Arena's live host and repository references to the retired runtime are
covered by this change. Other similarly named repositories are not proof of
shared runtime ownership; inventory them before changing their deployments.
Historical Git records, credential identifiers and the protected backup are
not active application code and were not erased.

The wider connection audit remains incomplete. After cleanup, the dedicated
probe passed mux entry (3,072 ms to snapshot) and fresh reconnect (1,929 ms).
A twenty-second observation received 10 deltas, 13 events and a heartbeat. Sustained reconnect behavior,
browser animations and the measured event-loop stalls still require verification.
