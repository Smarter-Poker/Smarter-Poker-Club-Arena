# Disaster Recovery Runbook

Written 2026-09-01 (audit phase 4). The platform had strong guards against
data _corruption_ and none written down against _loss_. This is the "it's
gone, now what" page. Read it before you need it.

## What the platform is made of, and where each part lives

| Component                          | Lives in                                                            | Reproducible from                                                      | Single copy?                    |
| ---------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| Club Arena frontend                | Hetzner `/srv/club-arena`                                           | GitHub `Smarter-Poker-Club-Arena`                                      | No - GitHub                     |
| Poker engine code                  | Hetzner `/opt/club-arena`                                           | GitHub `Smarter-Poker-Club-Arena` (`server/`)                          | No - GitHub, exact-SHA workflow |
| **Engine secrets (`server/.env`)** | **Hetzner disk only**                                               | **nothing**                                                            | **YES — see below**             |
| Database (chips, users, all state) | Supabase `kuklfnapbkmacvwxktbh` (Postgres 17; measure current size) | Supabase PITR / backups                                                | Supabase-managed                |
| Open Claw cron dispatcher          | Hetzner `/opt/openclaw`                                             | GitHub `Smarter-Poker-World-Hub` `scripts/openclaw-cron-dispatcher.py` | No — GitHub                     |
| CI/CD credentials                  | GitHub App + repo secrets                                           | —                                                                      | GitHub-managed                  |

The one host-only component is the engine's runtime `server/.env`. Routine
publishing never reads a workstation copy. For an explicitly authorized
offline DR backup, `scripts/dr/backup-engine-secrets.sh` requires a pinned host
key and an explicitly supplied DR SSH identity; it has no host/key fallback,
never reads a local `.env`, and never runs on a schedule.

## SCENARIO A — the engine box is gone (Hetzner disk dead)

Impact: live poker stops (no dealing). The database and web app are untouched;
players see tables that do not advance. Target: back in ~30 min.

1. Open an incident and provision a replacement Hetzner host using the reviewed
   infrastructure definition. Do not use a workstation as a publisher.
2. Restore or rotate runtime credentials through their owning providers. An
   authorized offline backup may be decrypted only inside the incident's
   secure transfer procedure; never print it or stage it in the repository.
3. Update the Club Arena repository's `HETZNER_HOST`, pinned
   `HETZNER_HOST_KEY`, and `HETZNER_SSH_PRIVATE_KEY` secrets after the new host
   identity is verified. If the static origin moved, update the separate
   `CA_ORIGIN_HOST`, `CA_ORIGIN_HOST_KEY`, and `CA_ORIGIN_SSH_KEY` set.
4. Send the intended full merged SHA through the Club Arena-owned
   `deploy-club-arena-engine` repository event. Publish the frontend through
   `publish-club-arena.yml`; do not clone/build/restart or sync from World Hub
   by hand.
5. Verify cache-busted engine health, both frontend `build-info.json`
   endpoints, and resumed hand progression against the exact merged SHA.

## SCENARIO B — database corruption or bad write (need a point in time)

Impact: depends. Chips are append-only and the ledger chain is
checksum-verified (`fn_ca_verify_ledger_chain`: 0 breaks at last check), so a
bad write is usually correctable forward with a compensating `chip_ledger`
entry via `fn_ca_post_correction` — prefer that over a restore.

Only if forward correction is impossible:

1. **Confirm PITR is enabled and its actual recovery window** through the
   configured Supabase Management API or project dashboard. Read
   `GET /v1/projects/{ref}/billing/addons` and
   `GET /v1/projects/{ref}/database/backups`; configuration alone is not a
   successful restore. Authorized agents can apply the supported
   `PATCH /v1/projects/{ref}/billing/addons` with
   `{"addon_type":"pitr","addon_variant":"pitr_7"}` through the existing
   credential-store identity. Preserve other add-ons and independently read
   back the result before considering a retry after an unknown response.
   Never print credentials or read them from environment files. Enabling PITR
   does not retroactively recover a time outside the reported window.
2. Identify the target time from `chip_ledger.created_at` / incident detection.
3. Restore into an **isolated NEW project first**. A physical Supabase clone
   copies credentials and can immediately run `pg_cron`, `pg_net` and other
   external integrations. Disabling these after startup is not isolation.
   Before starting a drill, require a supported pre-start containment method,
   or prepare a logical restore whose external effects are disabled before
   execution in the isolated environment. Never disable production schedules
   to prepare a drill. A schema-only or narrow financial fixture is not a full
   recovery certificate. Do not overwrite production to test a backup.
4. After any restore, run `fn_ca_verify_ledger_chain(50000)` and
   `fn_ca_daily_attestation()` before reopening play.

## SCENARIO C — the Mac is gone

The Mac holds clones, worktrees, and an optional sealed DR backup. It is a
single point of failure for development, not for the running Club Arena
platform, whose frontend and engine run on Hetzner and whose durable state is
in Supabase.

- Running platform: unaffected. Players and money are fine.
- To resume agent work: any machine with the GitHub App credentials and
  `gh auth` can clone the repos and ship. The estate is designed so nothing
  originates only on the Mac (AGENT-PLAYBOOK: push small, push often).
- The DR secret backup is Mac-local. If both the Mac and the engine box die at
  once, the engine secrets must be rotated fresh (new service-role key in
  Supabase, new INTERNAL_API_KEY, etc.) — recoverable, but a rotation, not a
  restore. Keeping a second encrypted copy off-Mac (a password manager entry)
  removes even that edge.

## STANDING CONTROLS — verify these are on

- [x] Supabase PITR enabled: seven-day `pitr_7` verified through both add-on
      and backup APIs on 2026-10-06 at 02:20 UTC. Approximately $100/month,
      prorated hourly. This is dated evidence; re-read before an incident.
      Recovery window then: 2026-09-29 11:49:49 to 2026-10-06 02:20:11 UTC.
      Database startup remained 2026-10-04 00:09:55 UTC, with no restart.
- [ ] Hetzner provider backups/snapshots enabled and restore-tested through configured
      provider access. If the offline backup is retained, refresh it only as an
      explicitly authorized DR operation with the pinned-host inputs.
- [ ] A restore drill into a scratch Supabase branch once a quarter — an
      untested backup is a hope, not a backup.
- [ ] Hetzner engine box: enable Hetzner's own snapshot/backup through the configured provider interface so Scenario A is a rollback, not a rebuild.

## DRILL LOG

| Date       | Scenario                     | Result                                                                                                                                            |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-01 | Ledger chain integrity       | 50,000 rows, 0 breaks (verified via MCP)                                                                                                          |
| 2026-09-01 | Engine secret backup         | 15 keys encrypted + roundtrip-verified                                                                                                            |
| 2026-10-06 | PITR seven-day configuration | Add-on and backup API readback passed; no database restart. **Not a restore drill.**                                                              |
| _next_     | Isolated full restore        | **Unverified**: pre-start external-effect containment and sufficient target capacity required. Measure recovery time and recovered data boundary. |

The 2026-10-06 local CLI schema export stopped before export because Docker
was unavailable. A full restore was not attempted: several individual tables
exceed tens of GB, and available local work space was approximately 46 GiB.
Do not treat a failed export, physical-backup listing, or enabled PITR as
restore qualification. Storage objects also need their own recovery evidence;
database backups do not contain Storage object bytes.

Provider references: [database backups](https://supabase.com/docs/guides/platform/backups),
[restore to a new project](https://supabase.com/docs/guides/platform/clone-project),
[PITR billing](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery).
