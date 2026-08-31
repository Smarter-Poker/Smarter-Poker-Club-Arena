# HANDOFF — five-phase hardening plan: phases 1-3 DONE, phases 4-5 REMAIN

**Written:** 2026-08-31 12:15 UTC by cowork-claude
**Repo:** `club-arena` (all work so far); phase 5 touches `Smarter-Poker-World-Hub` too
**Read first:** `AGENT-PLAYBOOK.md`, then `CLAUDE.md` in this repo. This file assumes both.

---

## 0. THIRTY-SECOND ORIENTATION

Dan reported a bug at 08:00 UTC: he sat at a table, the felt said *"Seat
Reserved, You'll Be Dealt In Next Hand"* forever, then *"Sitting Out. Seat At
Risk"*, then he was evicted after five minutes. Root-causing it opened a
five-phase hardening plan. **Phases 1, 2 and 3 are complete, merged, and
verified live in production. Phases 4 and 5 remain.**

Everything below is evidence-backed. Where I could not verify something, it
says so explicitly.

---

## 1. THE ORIGINAL BUG AND ITS ROOT CAUSE (phase 1) — DONE

**The engine was never broken.** `hand_history` proves it did everything right
for Dan's seat (table `08746c1a-eb99-403a-ad98-63e9739ef4e9`, seat 7,
2026-08-31 00:27:36 UTC): it released the wait-for-BB hold on the next hand
(#3769181), dealt him in, took his big blind (`7:bb:5`), and he won the pot.

**His client never rendered any of it.** `tableState.maxPlayers` is seeded to
**6** and corrected only when the client's own `tables` row query lands — and
`mapEngineSnapshot` dropped every seat above it (`if (idx >= maxSeats)
continue`). On a 9-max table, seat 7 was *him*, deleted from every snapshot. No
hole cards, no action bar, footer stuck on "Seat Reserved" — while the engine
offered him turns nobody could see, timed each one out, force-sat him out after
three strikes (he vanishes from deals at hand #3769389) and evicted the seat at
00:37:50.

### Merged PRs (all published, verified in the served bundle)

| PR | What |
|---|---|
| #2020 | The mapper can never drop a seat the engine publishes |
| #2049 | Engine publishes `max_seats`; `maxPlayers: 6\|9` widened to `number`; mirror invariant added |
| #2068 | **My own infinite render loop**, the prefetch seat-drop, and main's red tests |
| #2085 | The other two seat-drop sites (realtime merge, seat-first roster rebuild) |
| #2102 | Seat bound derived from the rings; `max_seats` on the third payload |

### The five seat-drop sites (all fixed)

1. `mapEngineSnapshot` — dropped seats above the caller's guess
2. `applySeats` — the REST prefetch that paints before the websocket connects
3. The realtime seat merge (`table_seats` -> `updatedPlayers`)
4. The seat-first roster rebuild (`seatRows` -> `rebuilt`)
5. The `GAME_START` resync path

### Three payloads now carry `max_seats`

`broadcastCurrentState` (live), `publishIdleState` (between hands — a
seat-first joiner at a quiet table sees ONLY this one), and **`getTableState()`
answering `GET /state/:id`**, which the client fetches on a websocket sequence
gap and dispatches as `GAME_START`. That third one was missed in the first cut
and matters most: a client that just lost frames is exactly the one whose view
may be wrong, and its fallback infers width from the HAND roster, which omits
anyone not dealt in (a player waiting for the big blind) — so the inference can
land BELOW the truth.

### Mistakes I made in phase 1, so you do not repeat them

- **I wrote an infinite render loop into the rescue path.** The heal grew the
  array with NULL rows and could never place the hero row, so its early-return
  guard never became true, every pass produced a new array identity, the
  effect's deps changed, and it ran again. Fixed by extracting a PURE function
  (`src/lib/heroSeatReconcile.ts`) returning `null` when nothing needs to
  change. **Lesson: an inline reducer whose guard depends on state it cannot
  itself produce will not terminate.**
- **I planted `MAX_SUPPORTED_SEATS = 10` while `SEAT_LAYOUTS` stops at 9** — ten
  rows of state against nine drawable positions, i.e. the exact bug being fixed,
  reintroduced by its own fix. Now derived from the layouts so they cannot drift.
- **I clobbered another agent's work** by copying whole files from the shared
  clone into a worktree while the clone was BEHIND `origin/main`. It silently
  deleted 188 lines. **See section 6 for the rule that prevents this.**

---

## 2. THE SILENT-CLIENT CANARY (phase 2) — DONE

The engine cannot see a browser. A heartbeat proves the app is running and the
network is up, nothing more — which is exactly the state Dan was in.

**The fingerprint, which a genuine AFK human almost never produces:**

```
connected  +  turns offered  +  never once acted, ever, at this table
```

Someone who plays then wanders off has acted at least once. Someone whose
client cannot show them the action never does.

- `DisconnectEngine` now carries `everActed`, `turnsOffered`, `lastTurnRenderedAt`.
- `reportSuspectedSilentClient()` fires at the exact moment the ladder condemns
  a player, and returns a verdict so tests can assert on it.
- **Diagnosis only** — the sit-out and eviction are unchanged. Letting it alter
  the outcome would let a broken client hold a seat forever.
- Optional `turnRendered` ack rides the existing heartbeat, written by the
  **ActionPanel's own render arm** (the only place that knows for certain), not
  re-derived beside the heartbeat.

**HORSES: there is no `is_horse` branch and none is needed.** A horse acts
through the same `performAction` path (HorseLogic -> scheduleHorseAction ->
performAction -> recordPlayerActed), so it sets `everActed` on its first
decision and can never trip the canary. The signal is behavioural, not an
identity test. A test asserts the absence of any such branch. **Do not
"optimise" this with an is_horse check — it violates the HORSES ARE PLAYERS law
(CLAUDE.md §10.5) and is unnecessary.**

PRs: **#2122** (the canary), **#2135** (it was watching one door of two —
`recordConnectedTimeout` AND `executeAutoAction` both force sit-outs; a test now
splits the engine source on every `sitOut(..., 'forced')` and requires the
canary call immediately before each).

---

## 3. DEFINER EXPOSURE (phase 3) — DONE

Supabase's advisor reported **852 security findings**. **852 -> 732**, every
`security_definer_view` ERROR cleared, one real hole closed, nothing broken.

PR **#2159**. Migrations registered in production: `20260831115405`
(`a_trigger_function_is_not_an_api`) and `20260831115746`
(`every_definer_view_respects_the_caller`).

- **173 trigger functions revoked.** PostgREST never exposes a function
  returning `trigger`. **Proven first in a rolled-back probe that trigger
  FIRING does not re-check EXECUTE** — otherwise this breaks every trigger on
  the platform. Verified live after: 163 `tables` rows stamped by their BEFORE
  UPDATE trigger, 58 new seats stamped by `fn_stamp_seat_club`.
- **`fn_union_eco_adjustment`** — SECURITY DEFINER, union id straight from the
  caller, **no caller check of any kind**. Stable, so it could not move money,
  but it handed any signed-in player another union's economy figures. Zero call
  sites. Revoked.
- **Three definer views, not two** — the third was created the same morning by
  another migration, so the fix sweeps every view we own rather than naming them.

### The remaining 568 warnings — DO NOT BLINDLY REVOKE THESE

565 browser-callable definers we own. **397 check the caller directly**
(`auth.uid()` / `auth.role()` / JWT). Of the 168 that do not, most are thin
wrappers delegating to one that does. I read every high-risk one:

- `promote_member` — takes `p_promoted_by` as a parameter (looks alarming) but
  delegates to `fn_club_set_member_role`, which sets `v_actor := auth.uid()`
  and trusts a supplied actor ONLY for `service_role`.
- `ca_union_record_presettlement` — guarded by `ca_can_oversee_union`, 42501.
- `fn_save_leaderboard_reward_setup` — delegates to
  `fn_publish_leaderboard_reward_program`, which refuses a NULL `auth.uid()`.
- `increment_promotion_claim_count` — read-only despite the name.
- `recalculate_leaderboard_ranks` — writes unguarded, but only recomputes
  `dense_rank()` from existing scores, so it cannot forge a position.

**The doors are exposed and each has its own lock.** Revoking a live RPC entry
point to satisfy a lint would break the product to fix a warning. The last
remaining ERROR (`spatial_ref_sys` without RLS) is a PostGIS extension table
owned by `supabase_admin` holding public constants — not ours.

**Trap that cost me a run:** a `REVOKE` issued by `postgres` against a grant
`postgres` never made is a **silent no-op, not an error**. The first run
reported success in its loop and the post-apply assertion caught two
`supabase_admin`-owned functions still exposed, rolling everything back. Scope
permission changes to `p.proowner = 'postgres'::regrole`.

---

## 4. WHAT REMAINS — PHASE 4 AND PHASE 5

### PHASE 4 (NEXT) — reconciliation that can be trusted

**The problem:** `ledger_reconcile_log` holds **21,271 critical rows all-time**.
The 2026-08-30 run alone produced 1,053 criticals across 322 entities:

| entity_type | scale |
|---|---|
| `club_treasury` | 3 entities, **30.5M chips** drift, worst single 25,370,482 |
| `seat_stack_exit` | 1,033 entities, 431,906 chips |
| `bomb_award_ledger_gap` | 17 entities, 1,418 chips |
| also present | `negative_balance`, `player_wallet` |

**An alarm that fires a thousand times a night cannot detect a real theft.**

**Diagnosis (do not re-derive):** the drift is structural, not missing money.
Money paths write `club_members.chip_balance` **directly** without touching
`chip_ledger` (`atomic_table_buyin` is the documented example, CLAUDE.md
§11.5), so the computed "ledger balance" goes NEGATIVE and every entity looks
critical. `fn_club_chip_circulation()` prints the two pools reconciliation never
looked at.

**Check this before building anything:** `fn_unaccounted_seat_exits()` returns
**0** right now, and the newest run (2026-08-31) shows **0 criticals**. Somebody
may already have improved this today. Do not fix a problem that has moved.

**Suggested approach (my judgement, not gospel):** either complete `chip_ledger`
coverage so every money path writes it, or scope `reconcile_ledger_nightly` to
the paths it genuinely observes and stop calling un-instrumented ones
"critical". The second is smaller and makes the alarm believable immediately;
the first is correct long-term.

**HARD RULE (CLAUDE.md §11.5): NEVER SPEND REAL CHIPS TO TEST A RULE.** Probe
money functions inside a transaction you ROLL BACK. Never DELETE a
`table_seats` row to clean up — that destroys chips. Helper functions go in
`pg_temp`, never `public`. An agent burned 48 real chips learning this.

### PHASE 5 — pipeline and queue health (I recommend pulling this FORWARD)

This is now the thing standing between "merged with green checks" and "provably
live" for every phase. Concrete, measured findings:

1. **The CA -> World Hub publish starves.** 16 of 20 sync runs cancelled in one
   window; main ran 11 commits ahead of the last sync. `cancel-in-progress` is
   deliberately `false`, but GitHub still cancels the *pending* run when a newer
   one queues, so on a busy day only the `*/20` catch-up cron ever lands.
2. **A red `main` stops ALL publishing.** The sync gate is literally *"Client
   tests must pass before the bundle ships"*. On 2026-08-31, PR #2054 renamed
   `withTable` -> `withJoinableTable` without moving two test pins (house rule
   8), and **nothing published platform-wide for ~40 minutes**.
3. **The engine deploy drain gate never sees zero.** It waits for
   `handsInFlightTotal` to reach 0; on a 53-table fleet it sits at **83-101
   permanently**. The workflow's own comments admit the 45-minute staleness cap
   (`MAX_ENGINE_AGE_SEC=2700`) is therefore not a backstop but the ONLY path a
   deploy takes. **The engine runs code up to 45 minutes old by design.**
4. **20 open PRs, all BLOCKED/UNKNOWN with auto-merge armed** (issue #375).
5. **The GitHub token lacks `checks:read`** — the check-runs API 403s, which is
   *why* nobody can see which check blocks a PR. Cheapest fix on the list.
6. **The token exhausts its rate limit** under this much polling. Fall back to
   `curl` on `build-info.json` and `/health`, which need no API.

### Other open items I found but did not action

- **WH #1064** global footer broken in production (filed today)
- **WH #771** six VIP entitlement defects behind the benefits page
- **WH #820** Solver v2 stalled since 2026-08-15, 6.6M spots outstanding
- **CA #1498** eight flows still push to OneSignal, removed 2026-08-19,
  delivering nothing
- **Post-Deploy E2E (production) is red** and blocks nothing — club-lobby specs
  time out with the browser closing under them. PR #2036 attempts it.
- **An `ANTHROPIC_API_KEY` is visible in a plain `ps` listing** on Dan's Mac.
  Any local process can read it. Worth rotating and passing via a file.

---

## 5. EXACT CURRENT STATE (verified 12:14 UTC, 2026-08-31)

```
origin/main         6a1992d270
engine (Hetzner)    816bdf9e   uptime 67s   handsInFlightTotal 83
client (published)  dbddd0859d
```

**All six phase 1-3 client PRs are PUBLISHED and verified in the served
bundle.** The engine carries the phase 2 canary. Nothing from phases 1-3 is
outstanding.

Re-verify without the GitHub API:

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json   # ca_sha served
curl -s https://engine.smarter.poker/health                    # version, uptime, handsInFlightTotal
# NOTE: /health is an EXACT-match route - a ?cachebuster= query string 404s.
cd ~/Documents/club-arena && git merge-base --is-ancestor <sha> <live_sha> && echo PUBLISHED
```

---

## 6. HOW TO WORK IN THIS ESTATE WITHOUT LOSING WORK

**These are not style notes. Each one cost me time today.**

1. **Never edit in the shared clone and copy files into a worktree.**
   `~/Documents/club-arena` is reset by an Antigravity `git reset --hard
   origin/main` loop and is frequently BEHIND `origin/main`. Copying a whole
   file from it into a worktree silently deletes newer work (188 lines, in my
   case). Work directly in a worktree, or apply your specific hunks with a
   script and CHECK `git diff --numstat` — an additive change shows `+N -0` or
   `+N -1`, never `-188`.
2. **Claim your own worktree** off `origin/main`:
   `git worktree add ~/Documents/.agent-trees/club-arena/<name> -b agent/<you>/<slug> origin/main`
   then provision `node_modules` with `cp -c -R` (APFS clone) from the shared
   clone, for BOTH root and `server/`.
3. **`git push -u origin HEAD`** — plain `git push` fails with a branch-name
   mismatch in a worktree.
4. **Long test runs die with the shell connection.** Launch detached:
   `nohup bash -c '... > /tmp/x.log 2>&1; echo "EXIT=$?" >> /tmp/x.log' >/dev/null 2>&1 & disown`
   then poll the log.
5. **The host terminal tool times out near 120s.** Keep `sleep` under ~110s and
   poll rather than blocking.
6. **`npm run build` locally is slow** (installs sharp). CI's "Production Build"
   is a required check and catches it anyway.
7. **GateGuard** demands you state importers / affected exports / data files /
   the user's instruction before each Edit or Write. Answer it and retry — it is
   not a bug.
8. **Test the assumption that could break production, in a rolled-back
   transaction, before you rely on it.** The trigger/EXECUTE probe is the model.
9. **Prove every new test is real**: break the code, watch it go red, restore
   it, watch it go green. I did this for every pin added today.

---

## 7. YOUR IMMEDIATE NEXT STEPS

1. Re-verify section 5's live state (it will have moved).
2. **Check whether `main` is green** before anything else — a red `main` blocks
   all publishing, and fixing it comes before your own work (CLAUDE.md §4).
   `cd <worktree> && npx vitest run tests/` — expect ~718 files / ~10,086 tests.
3. **Confirm the phase 4 premise still holds** — query `ledger_reconcile_log`
   for the newest run's critical count. The 2026-08-31 run showed 0.
4. Then start **phase 4**, or tell Dan you recommend **phase 5 first** (I do —
   it gates proof for everything else).
5. Report in Dan's format: `PHASE N OF 5 IS DONE`, the summary, then
   `READY TO START PHASE N+1 OF 5`.

**Dan's standing expectations:** verify against reality rather than assuming;
never claim success before you can see it in production; fix red `main` first;
audit your own work before moving on (every phase today turned up a defect in
the phase before it, including two of mine); and paste handoffs into the chat
as well as committing them.
