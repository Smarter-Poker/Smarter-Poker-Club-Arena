# 2026-09-04 - Chip continuity is house law on every cash table (Operation Table Stakes, Slice 0)

Programme: `docs/OPORD-1.4-AMENDMENT.md` (amends OPORD 1.3, which Dan pasted on
2026-09-03). This is GATE 1: Slice 0 on every cash table, no flag. Nothing
from Slices 1-6 (create flow, clusters, one lobby card, bombs, VPIP, the
autonomous lifecycle) is in this change.

## The law, in the only words a player may read (OPORD 1.3 section 6.1)

- Chips on the table stay on the table until you leave.
- If you are ahead of the money you put in, you remain seated for 10 minutes
  before you can leave.
- If you return to the same game in this club within 2 hours, you buy in for
  at least the stack you left with.

No badge, no lobby chip, no paragraph about why. The buy-in modal's minimum
is simply higher. The leave control reads "Leave Available In M:SS" while
locked. The words the OPORD forbids appear on no player surface;
`tests/chip-continuity-is-house-law.law.test.ts` scans every string literal
and JSX text in `src/` for them.

## Where it lives

**The database owns it** - `supabase/migrations/20260904120000_chip_continuity_slice_0.sql`,
one transaction (production DDL policy). Why the database and not the engine:
the engine restarts at :55 of every hour, and a clock kept in engine memory
resets with it - the exact defect that made the five-minute sit-out eviction
never fire (header of `ServerTableEngineBase.restoreSitOutsFromSeats`).

- `cash_player_session` - one open row per player per scope. `baseline` is
  money put onto the seat (buy-in + add-ons APPLIED, never a pending add-on,
  or a debited-but-undelivered add-on could unlock a leave). The clock is
  `stay_remaining_ms` AS OF `stay_last_tick_at` plus `stay_running`; derived
  on read (`fn_cash_stay_remaining_ms`), written only on a transition.
  Scope is `table` for now; the Slice 6 cutover rewrites open rows to
  `cluster`.
- `cash_rejoin_constraints` - the floor, keyed on player + club + variant +
  sb + bb. Table id and template name are absent on purpose (invariant I8).
- `fn_cash_session_evaluate(table, entries)` - the engine's transition hook:
  settle elapsed, then `running := active AND stack > baseline AND remaining
above zero`. A player with no session (seated before this migration) gets
  one with baseline = stack now, so nobody is locked for chips they did not
  win from here on. Engine-only.
- `fn_cash_leave_check` - I5: locked iff in profit AND time remains, whether
  or not the clock is currently ticking (a sat-out player who is up is still
  locked, A0.5).
- `atomic_seat_cashout_locked` gains `p_leave_mode` (`'voluntary' |
'forced' | NULL`). A browser caller is ALWAYS checked (A0.16). The engine
  is checked when it says `'voluntary'` (POST /leave, a horse departure, a
  leave_pending seat at settlement). NULL from the engine is a system exit
  (eviction, table close, bust, stale-seat sweep). Every exit closes the
  session and writes the floor iff chips left with the player. The
  three-argument overload is dropped so PostgREST sees one candidate;
  `fn_cashout_seats_for_closing_table` and `player_leave_table` pass
  `'forced'` so an admin closing a table from the browser is not refused by
  a player's clock.
- `atomic_table_buyin` - the per-table opt-in floor (`tables.no_rathole`,
  keyed to the table and the player's last seat there, on for 15 of 247
  live tables) is REPLACED by `fn_cash_rejoin_floor`: effective_min =
  min(table.max, max(table.min, required)); refusal `BUYIN_BELOW_FLOOR`.
  The column stays until the Slice 6 cutover drops it (lobby code and the
  nightly manifest still name it). One floor, not two.
- `atomic_table_addon` (applied), `resolve_pending_addon` (delivered),
  `fn_horse_fund_from_treasury` (horse reload) all raise the baseline by what
  landed. `atomic_table_addon` also refuses `BUYIN_ABOVE_MAX` in SQL (A0.17).
- `fn_horse_seat_from_treasury` applies the same floor and opens the same
  session. HORSES ARE PLAYERS (CLAUDE.md 10.5): nothing in the migration
  reads the horse flag.
- `atomic_table_withdraw` is DROPPED (A0.1, I1).
- `fn_thaw_platform` gains two steps: `cash_player_session.stay_last_tick_at`
  and `cash_rejoin_constraints.expires_at` shift by the frozen minutes
  (CLAUDE.md section 13 rule 4).
- `fn_cash_effective_buyin(table)` - what the buy-in modal renders, for the
  caller, already capped. `floor_applied` says the number moved; it says
  nothing about why.

**The engine mirrors it** - `server/src/engine/ChipContinuity.ts` (pure
helpers + `ChipContinuityTracker`), `server/src/services/supabase/cashSessions.ts`
(`evaluateCashSessions`, `atomicCashoutVoluntary`).

- Base: the tracker; `isContinuityActive()` (not pending sit-out, not sat
  out, connected, not away); a presence sweep from the 10-second heartbeat
  tick that sends ONLY transitions (and everyone once after a restart);
  `onLeaveRefusedAtSettlement`. Never evaluates while `isMaintenanceFrozen()`.
- Seating: `leaveTable` answers synchronously from the mirror with the label
  and `code: 'LEAVE_LOCKED'`, after the tournament branch. The between-hands
  cash-out goes through `atomicCashoutVoluntary`; a refusal keeps the seat,
  keeps the engine registrations, emits `leave_blocked`, and rebroadcasts.
  The old `markSeatAsLeft` fallback is gone from that path: it is the same
  RPC and would be refused for the same reason, and it used to tear down
  the player's registrations while they were still in the chair. `sitOut`
  reports both directions. `withdrawChips` is deleted.
- Settlement: new step `chip_continuity` after `sync_stacks`,
  `pending_addons` and `horse_rebuys`, before `horse_cashouts` and
  `leave_pending`, so every departure is judged against the post-hand stack.
  A horse at its profit target now leaves through `atomicCashoutVoluntary`
  and simply stays if refused - the target stands and it tries again when
  the big blind comes back around, exactly as a human would.
- `processLeavePending` cashes out with `'voluntary'`; a refusal clears
  `leave_pending` and tells the engine.
- `ServerTableEngine`: `getTableState`, `broadcastCurrentState` and
  `publishIdleState` all spread `seatFields()` (`session_baseline`,
  `stay_remaining_ms`, `stay_running`, `leave_locked`). All three, because
  two-out-of-three is how the sit-out tag went invisible on 2026-08-28.
- `HorseFleetManager.seatHorse`: a `BUYIN_BELOW_FLOOR` refusal is retried
  once at exactly the floor - a horse reading the higher minimum and paying
  it if its roll covers it. A second refusal is final and is not an error.
- Deleted: `handlers/withdrawchips.ts`, the `/withdrawchips` route.

**The client renders it** - `src/lib/chipContinuity.ts`,
`mapEngineSnapshot.heroLeave`, `TablePage` (`heroLeave` state, a 1s tick
while running, the menu item label, an early refusal in `handleLeaveTable`),
`LeaveTableConfirm` (`lockedLabel` disables confirm and shows it),
`BuyInModal` (notice removed), `TablePage` buy-in floor now read from
`fn_cash_effective_buyin` instead of the per-table `table_cashout_history`
(a second floor with a different key, client-side), `GameRulesModal`
(three House Rules sentences on cash tables), `CashierModal` (add-only),
`lobbyEntries` (no chip), `TableConfigPage` (no toggle), `cashBuyIn.ts`
(`BUYIN_BELOW_FLOOR` / `BUYIN_ABOVE_MAX` copy). Deleted:
`GameServerAPI.removeChips`, `TablePage.handleWithdrawChips`.

## Applied

Applied to production 2026-09-04 11:38 UTC via psql in one transaction
(exit 0, post-apply assertions passed) and recorded as
`supabase_migrations.schema_migrations` version `20260904120000`
`chip_continuity_slice_0`. First live effects within a minute: a buy-in at
PLO4 5/10 #2 at 11:39:20 opened the first `cash_player_session` row; a
cash-out at 11:39:19 through the OLD engine's three-argument call resolved
against the new signature and wrote the first `cash_rejoin_constraints` row.

## Rollout order and the window in between

The migration applies before the engine deploys (merge -> publish -> Hetzner
auto-deploy, with the :55 restart in between). In that window the OLD engine
still calls `atomic_seat_cashout_locked` with three arguments: `p_leave_mode`
is NULL, the engine is not enforced, and its own leaves go through as before.
Browsers are enforced from the moment the migration lands (a browser has no
session row until the engine evaluates one, so nobody is locked before the
new engine has seen their stack). Sessions ARE opened by every buy-in from
the moment the migration lands, so baselines are correct for everyone who
sits down after it; everyone seated before it gets baseline = stack at the
new engine's first sweep.

## Evidence

**Database, A0.2-A0.13 / A0.15-A0.17 / thaw** - run in a rolled-back
transaction against production (CLAUDE.md 10.9 rule 4 and 11.5; the probe is
`scripts/dev/probe-chip-continuity.sql`, one `DO` block that applies the
migration, runs the scenarios, and RAISEs its report so nothing commits;
`pgrst_ddl_watch`'s NOTIFY is transactional and dies with the rollback, so no
schema reload was triggered). Transcript, 2026-09-04 11:08 UTC, user
`2a8c045e` at NLH 1/2 in club `fade0000-...-0001`:

```
A0.2  session opened baseline=100.00
A0.2  evaluate@180 -> running=true remaining=600000 locked=true
A0.2  voluntary leave refused: LEAVE_LOCKED:599197                     PASS
A0.3  evaluate@90 -> running=false remaining=479191 locked=false       PASS
A0.4  evaluate@120 -> running=true remaining=479191                    PASS
A0.5  sit-out -> allowed=false remaining=478374                        PASS
A0.5  clock running while sat out = f                                  PASS
A0.6  reconnect -> running=true                                        PASS
A0.16 browser cash-out refused: LEAVE_LOCKED:477552                    PASS
A0.7  left with 250.00 -> constraint required=250.00 expires_in=02:00  PASS
A0.7  floor at sibling 1/2 table = 250.00                              PASS
A0.7  buy-in 100 at sibling refused: BUYIN_BELOW_FLOOR ... is 250.00   PASS
A0.7  buy-in 250 at sibling accepted                                   PASS
A0.8  floor at PLO same club = (none)                                  PASS
A0.9  floor at 2/5 same club = (none)                                  PASS
A0.10 floor at 1/2 other club = (none)                                 PASS
A0.15 open sessions while seated at two tables = 2                     PASS
A0.15 floor while seated with 300 at T1 = 250.00 (unchanged)           PASS
A0.15 left T1 with 300 -> floor now 300.00                             PASS
A0.7b floor after expiry = (none)                                      PASS
A0.11 bust-to-zero leave -> floor (none)                               PASS
A0.12 reload in place -> baseline=200.00 constraints=0                 PASS
A0.13 baseline after add-on 50 = 250.00                                PASS
A0.13 stack 260 vs baseline 250 -> locked=true                         PASS
A0.13 stack 240 vs baseline 250 -> locked=false                        PASS
A0.17 add-on above max refused: BUYIN_ABOVE_MAX ... maximum (400.00)   PASS
A0.1  atomic_table_withdraw definitions = 0                            PASS
THAW  shifted stay clock by 300 s, floor expires in 2100 s             PASS
```

Verified afterwards: `to_regclass('public.cash_player_session')` IS NULL,
`atomic_table_withdraw` still defined (1), the probe user holds 0 seats.
Nothing committed.

**Engine** - `server/src/engine/ChipContinuity.law.test.ts` (21 specs: the
mirror arithmetic, the tracker's transition-only reporting and freeze gate,
and source pins on every wiring point above). **Client** -
`tests/chip-continuity-is-house-law.law.test.ts` (A0.1 and A0.14 by scan,
the countdown, the mapper, the confirm dialog, House Rules). Both registered
in `docs/LAWS.md`.

## Scoreboard (OPORD 1.3 section 6.7)

| Spec  | Result | Evidence                                                              |
| ----- | ------ | --------------------------------------------------------------------- |
| A0.1  | PASS   | function dropped (probe); no client/server path (both law tests)      |
| A0.2  | PASS   | probe + engine law (`leaveLock`, `leaveTable` pin)                    |
| A0.3  | PASS   | probe (479191 remaining, not 600000)                                  |
| A0.4  | PASS   | probe (resumes from 479191)                                           |
| A0.5  | PASS   | probe + client law (`heroLeaveIsLocked` while paused)                 |
| A0.6  | PASS   | probe (active false -> true) + `isContinuityActive` pin               |
| A0.7  | PASS   | probe (250 floor, refusal, acceptance, expiry)                        |
| A0.8  | PASS   | probe (PLO same club: no floor)                                       |
| A0.9  | PASS   | probe (2/5 same club: no floor)                                       |
| A0.10 | PASS   | probe (1/2 other club: no floor)                                      |
| A0.11 | PASS   | probe (stack 0 leaves no floor)                                       |
| A0.12 | PASS   | probe (rebuy -> resolve_pending_addon raises baseline, no floor)      |
| A0.13 | PASS   | probe (baseline 250; 260 locks, 240 does not)                         |
| A0.14 | PASS   | client law scan over `src/`                                           |
| A0.15 | PASS   | probe (two sessions; floor unchanged while seated; 300 after leaving) |
| A0.16 | PASS   | probe (`SET ROLE authenticated` + jwt claims -> LEAVE_LOCKED)         |
| A0.17 | PASS   | probe (`BUYIN_ABOVE_MAX`) + engine cap in `addChips` (unchanged)      |

## Not in this slice, on purpose

- `tables.no_rathole` column and the `table_cashout_history` table are not
  dropped (cutover migration, Slice 6).
- The sit-out eviction (5 orbits / 5 minutes) still releases a locked
  player's seat as a system exit and writes the floor. OPORD 1.3 section 6.5
  lists "sit-out seat release" as a constraint-writing leave; the stay clock
  is about table rhythm, the floor is the money protection.
- `stay_clock_ms` and `rejoin_window_ms` are per-session columns with
  CHECK floors at 10 min / 120 min; Slice 1's template snapshot sets them.
