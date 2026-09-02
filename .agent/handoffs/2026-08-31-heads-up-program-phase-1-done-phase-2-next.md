# HANDOFF — HEADS-UP PROGRAM, PHASE 1 OF 7 COMPLETE, PHASE 2 NEXT

**Written:** 2026-08-31 ~12:00 UTC
**Author:** Cowork/Claude session that ran the full heads-up audit and Phase 1
**For:** the next agent picking this up cold, in a new chat
**Status:** Phase 1 shipped, merged, and verified in production. Phase 2 not started.

Read this whole file before touching anything. It contains the map, the
landmines, everything already done, and everything still owed.

---

# 0. THE 60-SECOND VERSION

Dan asked for a full audit of the heads-up games, then for every finding to be
broken into phases and built one phase at a time, with a summary after each
phase and explicit permission before starting the next.

- **7 phases were defined.** Phase 1 ("money owed to players") is DONE, merged
  and verified live. Phases 2-7 are specified below and NOT started.
- The next action is: **ask Dan to confirm, then build Phase 2 ("fairness in
  the hand")**. Do not start Phase 3 without a fresh green light — he wants one
  phase at a time.
- Two items are blocked on Dan personally (a VM credential and a money
  decision). They are NOT blockers for Phase 2.

---

# 1. THE PRODUCT YOU ARE WORKING ON

There are **TWO** heads-up products, not one. This is the single most
important fact in this document, and the first audit missed it for a while.

| Product | Shape | Volume (7 days) | Where |
|---|---|---|---|
| **Spin & Go** | 3-max hyper, multiplier wheel decides the prize | 20,932 | `tournament_type='SPIN'`, `variant='spin'`, `max_players=3` |
| **Heads-Up duel** | true 2-max SNG ("NLH Heads-Up 10/25/50/100", "Heads-Up Hyper Duel") | 10,989 | `tournament_type='SNG'`, `variant='sng'`, `max_players=2` |

41,641 genuinely heads-up hands were dealt in 24h. Both formats are live.

**Critical context:** in the last 24h, **1,294 Spins ran and exactly ONE had a
human in it**. The formats run almost entirely on horses. Every UX finding
below has therefore never been felt by a real player — which is why the
presentation phase is ranked lower than fairness and money, and why you cannot
rely on "someone would have noticed" as evidence that anything works.

---

# 2. YOUR ENVIRONMENT — READ BEFORE YOU TRY TO SHIP

## 2.1 Repos and mounts
- `~/Documents/club-arena` -> GitHub `Smarter-Poker/Smarter-Poker-Club-Arena`
  (client + server engine + supabase/migrations). In the Linux sandbox:
  `/sessions/<id>/mnt/club-arena`.
- `~/Documents/Smarter-Poker-World-Hub` -> `Smarter-Poker/Smarter-Poker-World-Hub`
  (Next.js host, `pages/api/cron/*`, Open Claw dispatcher). Sandbox:
  `/sessions/<id>/mnt/Smarter-Poker-World-Hub`.
- Supabase project ref: `kuklfnapbkmacvwxktbh`. Use the Supabase MCP
  (`execute_sql`, `apply_migration`) — it works and is the sanctioned path.

## 2.2 Credentials — WHERE they live, never the values
- **GitHub token that works:** `GITHUB_TOKEN` in `~/Documents/club-arena/.env`.
  Verified against `api.github.com/user` -> login `Smarter-Poker`.
- **The GitHub MCP servers are DEAD** (`mcp__github__*` and
  `mcp__plugin_everything-claude-code_github__*` both return
  `Authentication Failed: Bad credentials`). Do not waste time on them. Use the
  REST/GraphQL API directly from bash with the .env token.
- **CRON_SECRET that production accepts:**
  `~/Documents/Smarter-Poker-World-Hub/.env.vercel.prod.local`. Several other
  `.env*` files contain STALE cron secrets — only that one authenticated (200).
- **Supabase service role + URL for local scripts:**
  `SUPABASE_SERVICE_ROLE_KEY` and `VITE_SUPABASE_URL` in
  `~/Documents/club-arena/.env` (used by `scripts/ci/gen-schema-manifest.mjs`).

## 2.3 HOW TO SHIP (both repos)
`main` is protected by a ruleset in both repos: **no direct pushes**, squash
merges only, required status checks. The reliable flow, used ~10 times today:

1. Write files locally.
2. Create blobs -> tree -> commit -> branch via the Git Data API with the .env
   token. **Author/committer MUST be**
   `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` — Vercel
   BLOCKS deployments for commits it cannot attribute (World Hub CLAUDE.md
   CHECK 15).
3. Open a PR, then enable auto-merge via GraphQL
   `enablePullRequestAutoMerge(mergeMethod: SQUASH)`.
4. Poll `pulls/<n>` until `merged: true`. CI takes 5-20 minutes.
5. Verify in PRODUCTION, not in the PR. `https://smarter.poker/api/health`
   returns the deployed short SHA.

`scripts/git-safe-push.sh` is the documented path but requires the Mac host;
from the sandbox the API flow above is what actually works.

## 2.4 LANDMINES — every one of these cost real time today
1. **The local worktree gets wiped.** An Antigravity loop runs
   `git reset --hard origin/main` on Dan's Mac. It ate my edits TWICE
   mid-session. **Never leave work uncommitted.** If files vanish, recover them
   from the PR branch via the contents API — that is how I recovered.
2. **GitHub secondary rate limits.** Rapid blob creation starts returning
   `403 API rate limit exceeded` while `/rate_limit` still shows 5000/5000
   remaining (it is the *content creation* bucket). Wait 3-5 minutes and retry;
   do not thrash.
3. **`/sessions` disk fills to 100%.** `vitest` then dies with `ENOSPC`. Fix:
   `TMPDIR=/tmp npx vitest run ...` and `rm -rf ~/.npm/_cacache`.
4. **Supabase statement timeouts** on big aggregate queries. Narrow the window
   (e.g. 12h not 7d) or add a LIMIT. `fn_detect_double_dealing(20160)` times
   out; `(60)` and `(120)` are instant.
5. **PostgREST silently caps a select at 1000 rows.** This produced a wrong
   money number in a cron I wrote (reported 1,000 pending rakeback periods
   instead of 2,456). Always page with `.range()` on counts that matter.
6. **`https://engine.smarter.poker/health` is NOT reachable from the sandbox**
   (proxy returns `{"error":"Not Found"}` with HTTP 200). Do not use it to
   verify anything. Verify engine deploys through Supabase behaviour instead.
7. **The browser pane cannot log in** — the saved smarter.poker session is
   expired and agents must not type passwords. Dan was asked twice and has not
   signed in, so **no live UI walkthrough has ever been performed**. All UI
   findings below are code-read + DB-verified, not eyes-on.
8. **CI gates that will fail you** (club-arena): `check-definer-authorization`
   (any SECURITY DEFINER writer callable by a browser must revoke EXECUTE or
   check `auth.*` — it reads the migration file that DECLARES the function, so
   the guard must live in THAT file), `check-migrations-applied` (a repo
   migration declaring an object missing from
   `scripts/ci/supabase-schema-manifest.json` fails — regenerate with
   `node scripts/ci/gen-schema-manifest.mjs`), plus emoji ban and `.single()`
   ban. World Hub: `pages/api/cron/` file count cap 45 (currently 32), and
   **never add to `vercel.json` crons**.

---

# 3. WHAT IS ALREADY DONE (do not redo)

## 3.1 Pre-Phase work — 2026-08-30 spin audit (merged: CA #2011, WH #1051)
- `fn_spin_rake_rate` flattened to a single 0.08 (it was still banded 8/7/6/5%
  while the engine booked 8% — the recovery sweep and the engine disagreed).
- `fn_spin_sweep_unbooked` now settles at `SPIN_SEATS = 3` instead of
  `count(tournament_players)`.
- **`tables.game_type` law**: TableConfigPage was writing the VARIANT
  ('NLH','PLO6') where the platform expects the FORMAT ('cash'|'tournament'),
  so owner-created tables never matched the sit-out / zero-chip eviction sweeps
  and their zombie seats held engines forever. Writer fixed, 3 rows backfilled,
  `CHECK (game_type IN ('cash','tournament'))` added.
- `SPIN_BLIND_STRUCTURE` now DERIVED from `spinSpec.SPIN_BLINDS` (a hand-typed
  15-level 2-minute ladder diverged from the 10-level 3-minute one the engine
  actually plays; the pre-start Blinds tab lied).
- `HorseOrchestrator.launchSpin` RETIRED (no production caller; it registered
  horses instead of selling seats and overwrote `current_players` — the
  documented "0/3 with paid seats" incident shape). Test pin moved from
  "creates safely" to "does not create at all".
- **Dead World Hub route `pages/api/club-arena/create-table.js` DELETED**
  (zero callers; its rate limiting, role checks and validation never ran) and
  its validation ported into the DB: `fn_tables_creation_guard` BEFORE INSERT
  on `tables` — cash seat law (plo6 6 / plo5 7 / plo4,plo8,flo8 8 / else 9),
  positive+ordered blinds, `min_buy_in <= max_buy_in`, action time 10-120,
  name trim/60-char/angle-bracket strip. Client action-time slider floor
  raised 5s -> 10s to match.
- Migrations: `20260830_spin_flat_rake_sweep_seats_and_table_game_type_law.sql`,
  `20260831_table_creation_guard_replaces_dead_create_table_api.sql`.

## 3.2 PHASE 1 — "money owed to players" (merged: WH #1083, #1084, #1090, #1094; CA #2117)

**The bug.** Both VIP award sites converted a player's rake share with
`floor()`, so any game where their share was under 1 chip awarded ZERO points
and wrote no ledger row — while the rake was still taken. Measured over 48h:
every heads-up duel and Spin at 1/2/5/10 chips (610 duels + 1,870 Spins) earned
nothing; 19+ chips earned 2-24. That is ~55% of all games on both flagship
formats, at exactly the stakes a new player starts on.

**The fix (live in production).**
- `vip_points_carry(user_id, carry numeric CHECK 0 <= carry < 1)` +
  `vip_points_ledger.credit` — migration `20260831a`.
- `fn_award_vip_credit(user, credit, source_type, source_id, reason)` — banks
  the fraction, awards the whole part, idempotent via the ledger's existing
  unique `(user_id, source_type, source_id)`: it inserts the row FIRST with 0
  points and only moves the carry if the insert won. Both award sites rewired
  (`fn_award_vip_points_from_rake` trigger, `fn_attribute_tournament_rake`) —
  migration `20260831b`.
- **SECURITY FIX I had to make to my own work**: that function was SECURITY
  DEFINER, wrote to three tables, and EXECUTE was on the default grant — an
  authenticated browser could have minted its own points. Your CI gate caught
  it. Now guarded by `fn_caller_is_engine()` and revoked from
  anon/authenticated/PUBLIC — migration `20260831c`, with the guard also
  carried into `20260831b` so a clean replay is never the exposed version.

**Two dead crons rebuilt.** Open Claw had been firing
`/api/cron/rakeback-period-settle` and `/api/cron/player-stats-refresh` on
schedule for weeks against handlers **that never existed** (they were written
for `smarter-poker-workers`, a repo Phase 2B never created) — every fire hit a
404, and a 404 looks exactly like a healthy job.
- `rakeback-period-settle`: pages the pending set, calls `settle_club_rakeback`
  per club (idempotent; service role passes `fn_caller_is_engine`), supports
  `?dry=1`. **Dry run reports 2,456 pending periods, 278,579.42 chips owed to
  589 players, oldest period ended 2026-07-26.**
- `player-stats-refresh`: calls `fn_refresh_player_stats` (idempotent). Live
  run updated 504 users across 44,298 hands.
- Also removed both paths from `WORKERS_PREFERRED` in
  `scripts/openclaw-cron-dispatcher.py` — the dispatcher was routing them to
  the never-built workers VM.

**A regression found while sweeping.** `spin-sweep` returned 500 on every run
because its double-dealing forensic scan reused the sweep's 14-day window on a
`hand_history` self-join and hit the statement timeout — so the platform's only
check for two engines dealing one table had been reporting nothing but its own
failure. Given its own 120-minute window; production alerts went 3 -> 1.

**Verified live after merge:** browser roles cannot execute the award function;
155 ledger rows in 10 minutes with 61 sub-1 credits banked; carry invariant
intact; zero probe rows left behind; both cron endpoints 200 doing real work;
table creation guard live; spin rake flat 8%; dead create-table route 404.

---

# 4. BLOCKED ON DAN — NOT ON YOU

1. **The Open Claw fleet is 401ing platform-wide** since ~09:00 UTC 2026-08-31.
   The VM's `CRON_SECRET` no longer matches production. Proof that does not
   need VM access: at 11:15 UTC every **Vercel-native** cron ran
   (`recovery-probe`, `login-probe`, `sentry-signup-bridge`,
   `marketplace-health`, `trivia-tournament-tick`) and every
   **Open-Claw-only** cron did not (`push-dispatch`, `waitlist-sweep`,
   `spin-sweep`, and both Phase 1 jobs). Runbook committed at
   `Smarter-Poker-World-Hub/.agent/handoffs/2026-08-31-openclaw-secret-and-dispatcher-deploy.md`
   (and an earlier diagnosis at `...-cron-secret-mismatch-openclaw-401.md`).
   Needs `ssh root@178.104.160.250`, set the secret in `/etc/openclaw.env`,
   `systemctl restart openclaw`, then `bash scripts/deploy-openclaw.sh` from
   the Mac so the dispatcher routing change reaches the VM. **No sandbox agent
   has an SSH key — this is genuinely human-only.**
2. **The rakeback payout** — 278,579.42 chips to 589 players. Endpoint is
   built and dry-run verified; firing it is a financial decision.
   `curl -H "Authorization: Bearer $CRON_SECRET" https://smarter.poker/api/cron/rakeback-period-settle`
3. **VIP back-pay decision** — the `floor()` bug destroyed points historically.
   The loss can be computed and minted as back-pay, but minting points is Dan's
   call, not an agent's. NOT YET COMPUTED — offer to compute it.
4. **Spin pace ruling** — median Spin is 14.2 min (300-chip tier), 21.8 min
   (1000-chip), avg 45.5 hands. That is a turbo SNG, not a hyper. Options:
   2-minute levels, steeper ladder, or shallower start. Dan has not ruled.
5. **Heads-up horse thinking speed** — horses think 15% faster heads-up, one
   shared cadence across the fleet. Keep, or randomise per horse?
6. **Stakes schedule / rake+BBJ tier auto-fill** — carried by the deleted
   create-table route; live tables already sit outside those rules so a guard
   would refuse legitimate tables. Needs a ruling before it can be enforced.

---

# 5. THE PHASE PLAN — 7 PHASES, 1 DONE

## PHASE 1 — Money owed to players. **DONE** (section 3.2).

## PHASE 2 — FAIRNESS IN THE HAND *(NEXT — build this)*
1. **The heads-up first button is never randomised.** The secure random
   first-button draw exists ONLY inside the Spin reveal path
   (`server/src/tournament/TournamentManagerBase.ts` ~:2914). A 2-max SNG never
   reaches it and falls to `buttonSeats[0]` — the lowest occupied seat — and the
   seat-first opener always seats the horse in the lowest free seat. Heads-up
   the button IS the small blind: it acts first preflop and last postflop.
   Live win-rate by seat is 49.94/50.06 (horse-vs-horse masks it), but a human
   defaults to seat 2. Fix: reuse the Spin's own draw for every 2-handed start.
2. **3 -> 2 dead button: one player posts the big blind twice in a row.**
   `server/src/engine/ServerTableEngineDealing.ts` ~:1313-1336. When the BUTTON
   busts in a 3-handed spin, the BB stays the BB; TDA Rule 33's dead-button
   adjustment is not implemented and the "button must move" correction is
   explicitly disabled at 2 players. Hits roughly 1 in 3 spins that reach
   heads-up — a full big blind of EV.
3. **`resume()` reads the blind level by array index** instead of
   `resolveBlindLevel()` (`TournamentManagerBase.ts` ~:2315) — the one caller
   that ignores that function's own warning. After an engine restart a
   late-stage game resumes on the wrong clock.
Tests to write/extend: heads-up button randomisation, dead-button rotation,
resume-level fidelity. Do not weaken existing law tests
(`tests/animations-always-play.law.test.ts`, `no-auto-table-switch.law.test.ts`).

## PHASE 3 — CONFIG GUARDRAILS
1. **Create `src/config/headsUpSpec.ts`** — the 2-max product has NO spec file.
   Its truth is scattered across `SNG_BOARD_SHAPES`,
   `BLIND_STRUCTURES.HEADS_UP_3MIN`, two `SCHEDULE_*_PRESETS` maps and a JSON
   blob inside a migration. Almost every Phase 3/4 bug is a symptom of that.
   Mirror the Spin pattern (`src/config/spinSpec.ts` + a byte-identical server
   copy + a test asserting they match).
2. **The 5% heads-up rake is a TypeScript convention, not a DB rule.** The DB
   cap is a flat 10% (`20260821_tournament_rake_cap.sql` ~:42) and two live
   paths hardcode `0.1` (the restart-clone fee re-cut and `clampRakeToCap`'s
   default). History proves it bites: through 25 Aug, 1,869 duels were charged
   10%, 464 at 8%, 9 at 6.67%. Everything since 26 Aug is 5%, so this is a
   latent regression with no guard. Add a DB CHECK for `max_players <= 2` and
   kill the hardcoded paths.
3. **The Duel's blind ladder is 5 levels and then doubles every 2 minutes**
   (`ScheduledTournamentService.ts` ~:344 inherits an MTT hyper-turbo preset).
   Level 6 is 1600/3200 against a 5,000 stack.
4. Dead `BLIND_STRUCTURES.SPIN` constant contradicts spinSpec — delete.
5. `is_premium_spin` is write-only (no reader) — remove or wire.

## PHASE 4 — LIVENESS
1. **No "RUNNING but not dealing" watchdog.** 141 of 20,900 Spins (0.67%) over
   7 days ran past an hour; 120 of those with under 30 hands; average 22
   minutes of dead table after the last hand; **worst case 11 hours, 13 hands,
   blind level 158**. Evidence: tournament `0dc034bc-5b71-4ef8-92a0-612a26a6d452`
   sat RUNNING for 11 hours with two horses seated holding real stacks. The
   180-second zombie reaper rebuilds the engine but never asks whether hands
   resumed.
2. **Stuck-COMPLETING recovery has no age threshold** (`GameServer.ts`
   ~:2929-2938) — the 5-minute rule exists only in the comment. Safe on one
   instance; under `ShardManager` a second instance would start paying a
   tournament the first is mid-finish.
3. **`tournamentOwnedTables` never has entries removed** (`GameServer.ts`
   ~:169) — ~7,000 UUIDs/day leaked and hub rooms for dead tables never dropped.
4. **The scheduled "Heads-Up Hyper Duel" is born broken every cycle.**
   `ScheduledTournamentService` writes the tournament row but never inserts a
   `tables` row (no `from('tables')` call anywhere in it), so every instance is
   a husk until another service's repair pass rescues it — which then
   overwrites the advertised start time and injects a horse the schedule asked
   zero of. Net: ~1-3 minutes of joinability per ~35-minute cycle.

## PHASE 5 — INTEGRITY AND SAFETY
1. **Chip-dump scanning is dead.** Last CHIP_DUMP scan 14 Aug, last win-rate
   scan 18 Aug, `anti_cheat_events` 0 rows in 7 days. The
   `/api/cron/anti-cheat-{chip-dump,bot-timing,multi-account}` and
   `/api/cron/collusion-scan` handlers **do not exist** (404 in production) —
   same never-built-workers cause as the Phase 1 crons. There is no SQL
   function that WRITES chip-dump flags either (`detect_collusion_pairs` only
   READS `collusion_tracking`), so the detector itself must be written.
   2-max is the classic chip-dumping vector and has the least coverage.
2. **Scoring is calibrated to noise**: of 169,523 flags, 169,505 were
   auto-cleared at an average suspicion score of 96.8.
3. **No re-entry/cooldown limits on duels** — lose, re-enter the same board,
   repeat. Combined with (1) that is the exact shape a dumping pair would use.
4. **No heads-up disconnect protection and no time bank.** Zero heads-up
   branches in the disconnect/time-bank engines. A tournament sit-out is dealt
   in, posts blinds and is auto-folded; at 2 players with 2-minute levels a
   30-second signal drop is a lost buy-in, with no notice to either player.
5. `sp_prune_hand_history` keeps horse-only hands 7 days — **Dan has ruled this
   stays. Do not "fix" it.**

## PHASE 6 — PRESENTATION AND UX (all code-verified, none eyes-on)
1. **Every Spin lobby card says "300 chips / Turbo"**, including the 12.6% that
   deal 1,000 or 5,000. The recycler seeds `starting_chips: 300` and the real
   stack is written at draw time (`TournamentManagerBase.ts` ~:1661/:1712);
   the card reads the raw column (`arenaGameCardAdapter.ts` ~:69/91/98). A 100x
   is 5,000 chips at 250bb — the opposite of Turbo. Seated players watch their
   stack jump 300 -> 5,000 with no explanation.
2. **The 100x celebration is 2/3 invisible.** Confetti spread is a magic
   `4.16%` tuned for 24 pieces (`SpinWheel.css` ~:608); mega tier's 72 pieces
   position off-screen. 50x and 100x render identically to a 25x.
3. **Tile view: one table's wheel blanks all four.** `SpinWheel` is
   `position:fixed; z-index:99997; pointer-events:auto` with no `isActive` gate
   (`MultiTablePage.tsx` ~:3559) — blocks the whole grid ~15s, and you can be
   timed out on another table behind it.
4. **Reduced motion finishes the reveal in 2.4s then leaves a dead felt for
   ~14s** (`SpinWheel.tsx` ~:485).
5. **A late-reconnecting client gets a 4-frame flash** of the whole reveal and
   it is marked played, so they can never see it (`SpinWheel.tsx` ~:448).
6. **Animation-speed preference is ignored by the wheel** despite the code's
   own comment promising otherwise (`SpinWheel.tsx` ~:425).
7. **Fallback wheel animates off `started_at` while the broadcast uses
   `reveal_at`** (`TablePage.tsx` ~:1113 vs ~:12116) — a fallback client can be
   out of step with the other two seats, and the `hold_until` clamp is disabled.
8. **"Play Again" can land you on a full table** (`TournamentRankingHost.tsx`
   ~:191 — the one path skipping the capacity check), and its fallback URL
   `/tournaments?type=spin` carries a filter nothing reads.
9. **After the wheel, nothing says what the prize is.** The HUD carries
   Level/Blinds/Next/Rank/Left/Avg and no prize; "Avg" and "Left" are the two
   least useful numbers at a 3-handed table. Swap Avg -> Prize; put the
   80/12/8 ladder in the lobby popup.
10. **Paid 2nd/3rd exit through the "you busted" door** — a 100x runner-up
    takes 20% of the pool and gets the standard 2.5s bust animation.
11. **Heads-up is never announced on a Spin** (overlay deliberately suppressed
    — correct — but nothing replaced it). Suggest a non-blocking 1.5s pill.
12. **Accessibility**: the wheel result has no live region; the odds table is a
    broken ARIA table (`role="table"` over plain divs); the buy-in sheet has no
    Escape handler or focus trap.
13. **Landscape/short viewports clip the reveal** — `SpinWheel.css` has zero
    `max-height` media queries; `.sw__tree` renders at -10px and the buy-in
    sheet's confirm button can go off-screen.
14. **No seat-fill indicator or ETA while waiting** (median fill 188s, p95 74
    minutes — that spread alone is worth showing).
15. **Registration RPC wrapped in `retryAsync` with no idempotency key**
    (`TournamentService.ts` ~:995) — a blip after a committed buy-in tells the
    player "already registered" after charging them.

## PHASE 7 — PRODUCT AND PERFORMANCE
1. **Rematch does not exist** — the single highest-leverage retention feature
   for a 2-max format. Winner is auto-navigated back to the lobby.
2. **Heads-up CASH does not exist** — the engine supports 2 players
   (`minPlayersToDeal` returns 2) but zero 2-max cash tables exist and the
   horse fleet never creates one.
3. **Heads-up is invisible in stats** — `player_stats` has no format dimension
   at all, no HU leaderboard, no HU achievements.
4. **No matchmaking / challenge-a-player.**
5. Perf: the elimination sweep is 8-12 queries every 5s per tournament (~400
   q/s at 200 concurrent spins) for a 3-row table — a spin fast path plus a
   push from settlement would cut it to near zero AND shorten the gap between
   the last hand and the result card. `refreshBlinds()` re-reads the whole
   table row every hand for three columns that change every 3 minutes.
   `releaseDeadTournamentSeats()` polls unconditionally. The HUD fetches ~100
   columns per table on a 45s poll for a 3-minute game.
6. Sit-out auto-folds fire at 0ms while every other action gets a deliberate
   beat (horses 350-1250ms, pre-actions 900ms, settle 650ms) — against a
   disconnected opponent heads-up, hands resolve at machine speed.
7. Horse brain treats a spin table as an MTT for the first ~20s
   (`max_players === 3` falls to the `mtt` default).

---

# 6. VERIFIED CLEAN — do not re-audit these
- Spin money path: 2,698 completed spins in 48h, every winner paid exactly
  `buy_in x multiplier` via `fn_credit_and_log`; 0 unpaid, 0 wrong amounts;
  multi-row payouts only on 10x+ premium splits by design.
- Reserve pool solvent, 0 unpaid settlements, 0 draw-booking gaps since
  2026-08-25, all 41 historical shortfall backpays paid.
- Multiplier distribution matches `spinSpec`; client and server copies of
  `spinSpec.ts` are byte-identical (md5 checked).
- Duels: 10,996 completed in 7 days, 0 unpaid winners, winner-take-all payout
  stored not inferred, 5% in-hand cash rake correct, refunds unwind pool/rake/
  count/seat idempotently.
- Heads-up mechanics from hand one are correct (button = SB, acts first
  preflop and last postflop, correct labels, alternation cannot desync in a
  game that STARTS 2-handed, restored from hand history on restart).
- HORSES ARE PLAYERS: every `is_horse` filter in the spin/tournament path gives
  horses something; none denies them anything.
- Four independent stall watchdogs cover the 2-handed case (the gap in Phase 4
  is the "running but not dealing" case, which none of them cover).

---

# 7. HOW TO VERIFY YOUR OWN WORK (copy-paste)

```sql
-- Phase 1 still healthy
select (not has_function_privilege('authenticated',
        'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)','EXECUTE')) as browser_locked_out,
       (select count(*) from vip_points_ledger where created_at > now()-interval '10 minutes') as awards_10m,
       (select count(*) from vip_points_ledger where created_at > now()-interval '10 minutes' and points=0) as banked_10m,
       (select count(*) from vip_points_carry where carry >= 1 or carry < 0) as carry_violations;

-- Spin money integrity (should be 0 / 0)
with s as (select id, prize_pool from tournaments
           where tournament_type='SPIN' and status='COMPLETED' and created_at > now()-interval '24 hours')
select count(*) filter (where not exists (select 1 from wallet_transactions w
        where w.category='prize' and w.related_entity_id::uuid = s.id)) as unpaid
from s;

-- Phase 4 evidence (stalls)
select count(*) filter (where extract(epoch from (ended_at-started_at))/60 > 60) as stalls
from tournaments where tournament_type='SPIN' and status='COMPLETED'
  and ended_at > now()-interval '7 days';
```

```bash
# production build + endpoints
curl -s https://smarter.poker/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://smarter.poker/api/cron/rakeback-period-settle   # 401 = exists
```

---

# 8. YOUR FIRST FIVE MINUTES

1. Read `AGENT-PLAYBOOK.md` and `CLAUDE.md` in both repos (house law).
2. Confirm the token works:
   `curl -H "Authorization: Bearer $(grep -m1 ^GITHUB_TOKEN= ~/Documents/club-arena/.env | cut -d= -f2)" https://api.github.com/user`
3. Run the Phase 1 health SQL above — if anything is false, fix that before
   anything else.
4. Tell Dan: "Phase 1 of 7 is verified complete. Ready to start Phase 2 of 7 —
   fairness in the hand." **Wait for his go-ahead. He wants one phase at a
   time with a summary after each.**
5. Build Phase 2 exactly as specified in section 5, ship via the PR flow in
   2.3, verify in production, then summarise and ask before Phase 3.

**Never claim success from a merged PR.** Claim it from production: a deployed
SHA that contains your commit, plus a DB or endpoint observation that proves the
behaviour changed.
