# Disaster Recovery Runbook

Written 2026-09-01 (audit phase 4). The platform had strong guards against
data _corruption_ and none written down against _loss_. This is the "it's
gone, now what" page. Read it before you need it.

## What the platform is made of, and where each part lives

| Component                          | Lives in                                              | Reproducible from                                                      | Single copy?                      |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| Web app + Club Arena bundle        | Vercel (`hub-vanguard`)                               | GitHub `Smarter-Poker-World-Hub` + `club-arena`                        | No — GitHub                       |
| Poker engine code                  | Hetzner `/opt/club-arena`                             | GitHub `club-arena` (`server/`)                                        | No — GitHub, auto-deploys on push |
| **Engine secrets (`server/.env`)** | **Hetzner disk only**                                 | **nothing**                                                            | **YES — see below**               |
| Database (chips, users, all state) | Supabase `kuklfnapbkmacvwxktbh` (108 GB, Postgres 17) | Supabase PITR / backups                                                | Supabase-managed                  |
| Open Claw cron dispatcher          | Hetzner `/opt/openclaw`                               | GitHub `Smarter-Poker-World-Hub` `scripts/openclaw-cron-dispatcher.py` | No — GitHub                       |
| CI/CD credentials                  | GitHub App + repo secrets                             | —                                                                      | GitHub-managed                    |

The one part reproducible from **nothing** was the engine's `server/.env`.
Phase 4 fixed that: `scripts/dr/backup-engine-secrets.sh` keeps an AES-256
encrypted copy under `~/Documents/club-arena/.dr-backups/` (gitignored;
passphrase in the macOS login keychain). Run it after any secret rotation.

## SCENARIO A — the engine box is gone (Hetzner disk dead)

Impact: live poker stops (no dealing). The database and web app are untouched;
players see tables that do not advance. Target: back in ~30 min.

1. Provision a fresh Hetzner box (or use the Phase-1 CI box script as a
   template). Ubuntu 22+, Node via nvm, PM2 or the existing systemd unit.
2. `git clone git@github.com:smarter-poker/Smarter-Poker-Club-Arena.git /opt/club-arena`
   (the box deploys from GitHub; `git remote` on the old box confirmed this).
3. Restore the secrets:
   ```bash
   PASS=$(security find-generic-password -a smarter-poker -s dr-engine-env-pass -w)
   openssl enc -d -aes-256-cbc -pbkdf2 \
     -in ~/Documents/club-arena/.dr-backups/engine.env.enc -pass pass:"$PASS" \
     > /tmp/engine.env   # then scp to the new box as /opt/club-arena/server/.env
   ```
   The 15 keys include SUPABASE_SERVICE_ROLE_KEY, INTERNAL_API_KEY,
   TURN_STATIC_AUTH_SECRET, ALERT_WEBHOOK_SECRET.
4. `cd /opt/club-arena/server && npm ci && npm run build && pm2 start` (or
   `systemctl start` the engine unit). Point DNS `engine.smarter.poker` at the
   new IP if it changed.
5. Verify: `curl https://engine.smarter.poker/health` returns the running sha,
   and per-minute `hand_history` counts resume (see CLAUDE.md 11 verification).
6. Re-point `auto-deploy-hetzner.yml`'s HETZNER_HOST secret if the IP changed.

## SCENARIO B — database corruption or bad write (need a point in time)

Impact: depends. Chips are append-only and the ledger chain is
checksum-verified (`fn_ca_verify_ledger_chain`: 0 breaks at last check), so a
bad write is usually correctable forward with a compensating `chip_ledger`
entry via `fn_ca_post_correction` — prefer that over a restore.

Only if forward correction is impossible:

1. **Confirm PITR is enabled and its window** in the Supabase dashboard
   (Project → Database → Backups). If it is NOT enabled, enable it now — this
   is the single most important standing DR control and an agent cannot toggle
   it. On the current plan, daily backups exist; PITR (second-granular) is the
   add-on that makes "restore to 3 minutes before the bad write" possible.
2. Identify the target time from `chip_ledger.created_at` / incident detection.
3. Restore into a **NEW branch/project first** (never overwrite production
   blind), verify the ledger chain there, then cut over.
4. After any restore, run `fn_ca_verify_ledger_chain(50000)` and
   `fn_ca_daily_attestation()` before reopening play.

## SCENARIO C — the Mac is gone

The Mac holds canonical clones, agent worktrees, the DR secret backup, and
keychain credentials. It is a single point of failure for _development_, not
for the _running platform_ (which is Vercel + Supabase + Hetzner).

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

- [ ] Supabase PITR enabled (dashboard; agent cannot check or toggle it —
      **Dan/human action**).
- [ ] `scripts/dr/backup-engine-secrets.sh` run after every secret rotation.
- [ ] A restore drill into a scratch Supabase branch once a quarter — an
      untested backup is a hope, not a backup.
- [ ] Hetzner engine box: enable Hetzner's own snapshot/backup in their console
      (**human action**) so Scenario A is a rollback, not a rebuild.

## DRILL LOG

| Date       | Scenario                         | Result                                   |
| ---------- | -------------------------------- | ---------------------------------------- |
| 2026-09-01 | Ledger chain integrity           | 50,000 rows, 0 breaks (verified via MCP) |
| 2026-09-01 | Engine secret backup             | 15 keys encrypted + roundtrip-verified   |
| _next_     | PITR restore into scratch branch | **TODO — first real drill**              |
