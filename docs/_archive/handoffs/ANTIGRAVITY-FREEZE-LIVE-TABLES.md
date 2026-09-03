# ANTIGRAVITY PROMPT — Freeze All Live Tables Until Sim Testing Complete

Paste the block below into Antigravity. It is self-contained, has SSH access, and
will follow the instructions end-to-end. Do not edit unless you want to change scope.

---

## Instruction to Antigravity

You are operating on the smarter.poker platform. Read `~/Documents/club-arena/CLAUDE.md`
and `~/Documents/Smarter-Poker-World-Hub/CLAUDE.md` before doing anything.

### Goal (binding)

**NO live poker tables may deal a single hand until Dan gives an explicit go-ahead in
a future session.** The platform is entering a beta-testing phase where all UI
validation happens exclusively via the browser scenario stepper at
`https://smarter.poker/hub/club-arena/sim` (a deterministic client-only page, no
engine calls). Any running table, any horse seating, any auto-revival of the E2E
test table — all of it must stop and stay stopped.

Do NOT interpret this as "close tables in the DB and walk away." The Hetzner
engine will revive tables on its own within 30 seconds. You must stop the engine
itself and leave it stopped.

### Context you need

- **Hetzner VPS** runs the authoritative poker engine: `ssh root@engine.smarter.poker`
- **Service manager**: PM2, process name `club-arena-engine`
- **Auto-revival problem**: the engine boots with env var `TEST_TABLE_ID=59938155-11ba-440f-9017-66019a2d697e`.
  That id is a "protected" E2E test table the engine refuses to let die. Every
  ~30s the in-process `HorseFleetManager` re-seats 4-6 horses at it
  (`server/src/services/HorseFleetManager.ts`, line 136 flips `closed` → `waiting`
  by name; `server/src/engine/ServerTableEngine.ts` line 4224 writes the DB row
  back to `running` after every hand). There is also a `DISABLE_HORSE_FLEET=true`
  env var the engine respects on boot (`server/src/index.ts` line 464 and 478).
- **Supabase**: project id `kuklfnapbkmacvwxktbh`. Tables involved:
  `tables`, `table_seats`, `table_hole_cards`, `tournaments`.
- **Sim page**: `/Users/smarter.poker/Documents/club-arena/src/pages/SimPage.tsx`
  was deployed at commit `30b04d6a3` (live on prod as of `074942b4`). It is
  fully standalone — no Supabase, no engine, no sounds, no auth. Beta testing
  runs through it.

### Steps — do every one, in order, verify each before moving on

1. **SSH into Hetzner**:

   ```
   ssh root@engine.smarter.poker
   ```

2. **Snapshot current state before you change anything** (save to your session notes):

   ```
   curl -s http://localhost:8080/health
   pm2 status
   pm2 env club-arena-engine | grep -E 'TEST_TABLE_ID|DISABLE_HORSE_FLEET|NODE_ENV'
   ```

3. **Stop the engine**:

   ```
   pm2 stop club-arena-engine
   ```

   Do NOT delete or restart yet.

4. **Confirm the engine is offline** from outside the box:

   ```
   curl -sS https://engine.smarter.poker/health
   ```

   Expect a connection error / 502 / empty — not a 200. If you still get a 200,
   dig in and figure out why the reverse proxy (Caddy) is still answering — do
   not proceed until /health is dead.

5. **Clear engine env so it can't auto-protect the E2E table if anyone restarts it**:
   Edit the PM2 ecosystem file or shell rc that holds the env vars. Set:
   - `DISABLE_HORSE_FLEET=true`
   - Remove `TEST_TABLE_ID` entirely (unset, delete from ecosystem.config.js or .env)
   - Add a comment in that file: `# FROZEN by Dan 2026-04-19 — no restarts until beta sim testing complete. See prompts/ANTIGRAVITY-FREEZE-LIVE-TABLES.md`
     Then `pm2 save` so the dead state persists across VPS reboot.

6. **Clean the Supabase DB** (fresh pass — the engine kept reviving things, so
   redo it now that the engine is offline):

   ```sql
   BEGIN;
   UPDATE table_seats
     SET left_at = NOW(), leave_pending = false, is_sitting_out = true
     WHERE left_at IS NULL AND (user_id IS NOT NULL OR horse_id IS NOT NULL);
   UPDATE tables
     SET status = 'closed', is_deleted = true, deleted_at = NOW(),
         current_players = 0, live_state = '{}'::jsonb, updated_at = NOW()
     WHERE status IN ('running','waiting','paused','active','live');
   DELETE FROM table_hole_cards;
   UPDATE tournaments
     SET status = 'CANCELLED'
     WHERE status IN ('ANNOUNCED','REGISTERING','RUNNING');
   COMMIT;
   ```

   Use `mcp__527a2e75-ebb7-44df-9538-92d3a9619012__execute_sql` with project_id
   `kuklfnapbkmacvwxktbh`.

7. **Verify DB is clean**:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM tables WHERE status <> 'closed') AS non_closed_tables,
     (SELECT COUNT(*) FROM table_seats WHERE left_at IS NULL AND (user_id IS NOT NULL OR horse_id IS NOT NULL)) AS active_seats,
     (SELECT COUNT(*) FROM table_hole_cards) AS hole_cards,
     (SELECT COUNT(*) FROM tournaments WHERE status IN ('RUNNING','REGISTERING','ANNOUNCED')) AS live_tournaments;
   ```

   All four counts must be zero.

8. **Verify the engine stays dead for 2 minutes** (the HorseFleetManager tick is
   30s — if the engine were up, hands would resume). Poll twice, 60s apart:

   ```
   curl -sS https://engine.smarter.poker/health || echo "engine offline — good"
   ```

   After 2 min, re-run the Step 7 SQL. All four counts must STILL be zero.

9. **Add a banner to the Club Arena lobby** (non-destructive, 5-line edit) so
   any user who hits the site during the freeze sees it:
   - File: `/Users/smarter.poker/Documents/club-arena/src/pages/ClubCarouselPage.tsx`
     (or the main lobby landing — find the one that renders the cash table list)
   - Add a dismissible info banner at top: `"Live tables temporarily offline for
beta testing. Try the scenario stepper: /hub/club-arena/sim"` with a link
     to `/sim`. No emoji. Inter font.
   - Build, sync to World Hub, deploy via `bash scripts/git-safe-push.sh
"club-arena: add beta-freeze banner pointing to /sim"`. Wait for
     DEPLOY_VERIFIED:true before claiming done.

10. **Write it down** (rule 9 of CLAUDE.md):
    - Append to `~/Documents/club-arena/MIGRATION-CHANGELOG.md`:
      ```
      ## 2026-04-19 — BETA FREEZE
      - Hetzner engine stopped via `pm2 stop club-arena-engine`
      - Env cleared: TEST_TABLE_ID removed, DISABLE_HORSE_FLEET=true persisted to PM2 ecosystem
      - Supabase state wiped: 0 tables running, 0 seats occupied, 0 hole cards, 0 live tournaments
      - Lobby banner deployed pointing users to /sim
      - Re-enable: reverse step 5 (re-add TEST_TABLE_ID if wanted, remove DISABLE_HORSE_FLEET), `pm2 start club-arena-engine`, remove banner
      ```

### What NOT to do

- Do not restart the engine "just to test it stays down". It won't. That's
  literally the problem we're avoiding.
- Do not trigger any tournament from the Commander UI.
- Do not run any of the `scripts/verification-harness/` scripts that hit the
  engine — they'll show engine offline as a failure when it's actually the
  desired state.
- Do not assume `is_deleted=true` is enough — it isn't. HorseFleetManager
  doesn't check that flag.

### Success criteria (all must be true)

- `pm2 list` on Hetzner shows `club-arena-engine` status `stopped`
- `curl https://engine.smarter.poker/health` fails (no 200)
- Supabase has 0 non-closed tables, 0 active seats, 0 hole cards, 0 live tournaments
- State above holds for 2 full minutes with the engine down
- Lobby shows the beta-freeze banner with a /sim link, deploy verified via /api/health
- MIGRATION-CHANGELOG.md updated

Report back to Dan with the numbers from Step 7 and the banner deploy SHA.
Do not end the session until `git-safe-push.sh` exits 0 and every success
criterion above is confirmed.
