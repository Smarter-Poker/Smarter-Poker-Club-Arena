# Union Economy And Floor Build-Out Plan

**Date:** 2026-09-02
**Author:** Cowork agent session, from Dan's specification of 2026-09-02
**Status:** Phases 0-6 not started. Phase 0 is a prerequisite for everything else.

---

## 0. What this document is

Dan restated how Midway Union is supposed to operate, and specified the shape
the floor should have. This plan turns that into ordered, verifiable phases.

Every claim of current state in this document was measured against production
on 2026-09-02 between 15:30 and 17:00 UTC. Numbers are quoted with the query
that produced them so the next agent can re-run rather than re-derive.

**Read `AGENT-PLAYBOOK.md` first. Then `CLAUDE.md`. This document does not
override either.**

---

## 1. The rules, as Dan stated them

### 1.1 How a union works

Horses are **members of the clubs** (Club JAQK, Shark Club). Joining the union
makes them union members too, but:

- **All gameplay is still 100% played inside and tracked through the club the
  player is in.** The union only HOSTS.
- The union **provides all games** and **tracks all payouts, rake and BBJ**.
- **All rake, BBJ and spins treasury is held by the union.**
- The union **pays 90% rakeback weekly to the clubs attached to it** and keeps
  the rest.
- The union **settles up weekly**, collecting from losing clubs and paying
  winning clubs at the end of the week.
- With two clubs today, they settle against each other or against the union.

### 1.2 Floor shape

**Cash tables** - of all cash tables:

| Bucket         | Share |
| -------------- | ----- |
| Full of horses | 25%   |
| 1-2 open seats | 25%   |
| 2-4 open seats | 25%   |
| Empty          | 25%   |

So **75% running, 25% empty**.

**Spins and heads-up** - only **25% running**, the rest empty.

**Fill rule:**

- **Spins:** 2 horses sign up, then wait **60-150 seconds (random)** for a 3rd
  to join and start the spin.
- **Heads-up:** 1 horse signs up, then waits **60-150 seconds (random)** for a
  2nd to join and start the match.

### 1.3 Multi-tabling

**Users may play up to 4 games at a time. Horses should be playing multiple
games at the same time.**

---

## 2. Measured current state (2026-09-02)

### 2.1 What already matches the spec

These are built and working. Do not "fix" them.

| Rule                                      | Evidence                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Games hosted by the union                 | `union_id` set on all 76 live Midway tables                                                                                     |
| Play tracked through the player's club    | Live seats stamped 212 Club JAQK / 201 Shark Club, 0 on the union                                                               |
| Union holds the rake treasury             | `union_wallets.rake_wallet` = 1,934,631.43, updating live                                                                       |
| Union holds BBJ                           | Active pool is union-scoped: 98,116.94 main + 26,743.11 backup, 45 hits. Club JAQK pool `retired_settled`, Shark pool `retired` |
| Union holds the spins treasury            | `spin_bonus_pools` row with `owner_kind='union'`, balance 60,878.72 across 35,922 spins                                         |
| 90% rate is configured                    | `union_clubs.club_commission_rate` = 0.9000 for both clubs                                                                      |
| Deep Stack Society sits outside the union | `clubs.union_id IS NULL`, own club-owned BBJ and spin pools                                                                     |

Note: `union_wallets.bbj_wallet` and `union_wallets.spin_reserve_wallet` both
read 0. That is **not** a leak - those columns are unused. The real BBJ lives
in `bbj_pools` and the real spin treasury in `spin_bonus_pools`, both correctly
union-scoped. Do not "repair" the zeros by moving money into those columns.

### 2.2 What does not match the spec

**(a) Rake is booked to the union-as-a-club, not to the member clubs.**

All 76 live Midway tables are _owned_ by the `Midway Union` club row. Club JAQK
and Shark Club own **zero** live tables (13 and 22 historical rows, all closed).
Rake attribution follows `tables.club_id`, so it books to the union:

```
rake_records + rake_attributions, last hour, non-tournament:
  Midway Union        169.85
  Club JAQK             0.00
  Shark Club            0.00
while live seats were:  Club JAQK 212, Shark Club 201
```

Weekly rollup shows the same shape:

```
union_rake_weekly:
  week 2026-08-31   Midway Union 153,915.78   JAQK 0        Shark 0
  week 2026-08-24   Midway Union 960,912.79   JAQK 1,267.20
  week 2026-08-17   Midway Union 543,400.51   JAQK 13,986.95   Shark 441,953.73
```

This is the one that matters. **It removes the basis for the 90% payback** -
there is nothing booked per club to pay 90% of. It was not always so: the week
of 08-17 attributed real money to both clubs. The change tracks table ownership
migrating onto the union row.

**(b) The weekly cycle is not running.**

- Last rakeback: `union_rakeback_log` executed **2026-08-20**, for the week
  **2026-08-10 to 2026-08-17**.
- The weeks of **08-17, 08-24 and 08-31 are unsettled**.
- Every row in `union_pnl_settlements` is from 2026-08-20 and has a period
  **1 to 2 seconds long** (e.g. `03:40:30.61` to `03:42:22.20`). Those are
  manual test invocations, not a weekly cadence.
- Nothing is scheduled to produce them. There is no Open Claw job for it.

**(c) `union_club_terms` is empty (0 rows).** No security deposit, stop-loss
limit or stakes cap per club. The 90% rate itself is fine - it lives in
`union_clubs.club_commission_rate` - but the risk terms the settlement model
implies are not configured.

### 2.3 Multi-tabling: the capability exists, the caps disagree

The controller functionality Dan asked about **is already there**:

- Each table is its own `ServerTableEngine` instance with its own
  `handController`, and `scheduleHorseAction` is a method on that instance.
  There is **no global per-horse lock**, so one horse can be driven on several
  tables concurrently by design.
- `HorseFleetManager` enforces `MAX_TABLES_PER_HORSE = 4` when picking seats.
- `EngineWebSocketServer` muxes `MUX_MAX_TABLES = 4` table subscriptions per
  connection, described in-code as matching "the client's 4-table device cap".

Two gaps:

1. **The authoritative guard is wrong.** `atomic_table_buyin` declares
   `v_max_tables CONSTANT INT := 6` and raises `TABLE_CAP_REACHED` at 6. The
   engine caps at 4, the client caps at 4, Dan's rule is 4. The database - the
   only cap that cannot be raced around - allows 6.

2. **`HorseLogic.ts` carries module-level mutable state** (`pendingRaisePlan`,
   `difficultyHint`, `lastIcmPath`). The in-code justification is "decisions are
   synchronous". That argument is sound for `difficultyHint` (set and consumed
   inside one call). `pendingRaisePlan` is set on a postflop decision and
   consumed in `betSize`/`raiseTo`; if every postflop path that reaches those
   two functions is dominated by the assignment, it is safe. **This has not been
   proven**, and it is exactly the class of state that breaks when one process
   drives many tables. It must be verified before multi-tabling is scaled up.

Measured reality today: **1.106 tables per seated horse**, max 2, 32 horses on
more than one table. That is a supply problem, not a capability problem - see
2.4.

### 2.4 The floor does not currently have the horses to fill itself

| Metric                                             | Value              |
| -------------------------------------------------- | ------------------ |
| Live cash tables (non-tournament, waiting/running) | **1,134**          |
| ...of which actually `running`                     | **71** (300 seats) |
| ...`waiting`                                       | 1,063 (36 seats)   |
| Cash tables completely empty                       | **1,041**          |
| Horses total                                       | 1,000              |
| ...in the cash lane (`lane <> 'events'`)           | 671                |
| ...of those, tied up in live tournaments           | 332                |
| Horses free anywhere right now                     | **6**              |

**6.3% of cash tables are running against a 75% target.**

Dan's distribution averages ~3.375 seated players per table
(`25%x6 + 25%x4.5 + 25%x3 + 25%x0` on 6-max). Against roughly 365 cash-capable
horses that supports **about 110 live cash tables**. There are 1,134.

**No scheduling, packing or seeding change can resolve this.** It is arithmetic.
Either the live cash floor comes down to ~110 tables, or the roster grows past
1,000. This is a decision for Dan and it gates Phase 5.

### 2.5 Spins and heads-up today

Both exist, in the **tournament** layer, not as cash tables (`tables.is_spins`
matched nothing; all 1,134 live non-tournament tables are ring games).

| Format                     | Registering     | Running         | Total | % running | Target |
| -------------------------- | --------------- | --------------- | ----- | --------- | ------ |
| Spins (`max_players=3`)    | 10 (14 players) | 37 (91 players) | 47    | **79%**   | 25%    |
| Heads-up (`max_players=2`) | 46 (38 players) | 33 (66 players) | 79    | **42%**   | 25%    |

Both run hotter than the 25% target. The waiting rooms are also not at the
sign-up counts Dan specified: spins average 1.4 registered per open table
(spec: 2), heads-up 0.83 (spec: 1).

The only pacing knob that exists is `spin_fill_policy.unfilled_timeout_minutes`
= **30**. There is no 60-150 second join rule anywhere.

### 2.6 Prerequisite already in flight

**PR #2655** (`fix/the-seeder-cannot-see-the-newest-tables`) fixes a silent
1,000-row PostgREST truncation in `HorseFleetManager.seedAllTables()`. With
1,134 live tables the newest 134 were invisible to the seeder, so the 45 Midway
micro tables created that morning were never offered a horse.

**Nothing in Phases 3-6 can be verified until that is merged**, because the
seeder cannot act on tables it cannot see.

---

## 3. The phases

Phases are ordered by dependency. Do not start a phase before its predecessor
is verified in production.

### Phase 0 - Land the seeder truncation fix (PREREQUISITE)

**Goal:** the seeder can see every open table.

1. Merge PR #2655.
2. Confirm on the live engine that the newest tables are being offered horses:
   seats appear on tables created most recently, not only on the oldest.

**Done when:** cash seat joins in a 10-minute window include tables from the
newest 134 by `created_at`. Today 100% of joins land on Deep Stack Society
(older) and 0% on the Midway micro floor.

**Risk:** none. Behind an existing test, and fails closed.

---

### Phase 1 - Attribute rake to the member club, not the union

**Goal:** every raked hand books to the club the _player_ belongs to, so the
union has a per-club basis to pay 90% of.

This is the highest-value phase. Everything about weekly settlement is
downstream of it.

**The decision to make first (Dan):** there are two ways to get there, and they
are not equivalent.

- **Option A - attribute by seat.** Leave table ownership alone and change rake
  attribution to follow `table_seats.club_id` (already correctly stamped: 212
  JAQK / 201 Shark). Rake splits per player, per hand, which is what "tracked
  through the club they are in" literally says, and it handles a table with
  players from both clubs correctly.
- **Option B - re-own the tables.** Rotate `tables.club_id` across member clubs
  (the fleet manager already has `getNextClubId()` for this) so a whole table's
  rake books to one club. Simpler, but a table seats players from both clubs, so
  it attributes one club's rake to the other.

**Option A is the recommendation.** `rake_attributions` already carries
`player_id` and a per-player `weighted_rake_credit`, so the per-player split
exists; what is wrong is the `club_id` stamped alongside it.

**Steps:**

1. Confirm where `rake_records.club_id` and `rake_attributions.club_id` are
   written (engine settlement path). Change the attribution stamp from the
   table's club to the seat's club.
2. Backfill is a **separate decision** - see Phase 2 open question.
3. `union_rake_weekly` rolls up from attribution; confirm it follows without
   change once the stamp is right.

**Done when:** for one hour of live play, `rake_attributions` grouped by club
shows JAQK and Shark in proportion to their seated share, and Midway Union at
zero. Today it is the exact inverse.

**Risk:** money attribution. Nothing moves chips; it changes which club is
credited. Reversible by re-stamping. Must not double-count: verify
`sum(rake_attributions.rake_amount)` per hand still equals
`rake_records.rake_amount`.

---

### Phase 2 - Make the weekly cycle actually run

**Goal:** 90% rakeback and P&L settlement run every week, on a schedule, with
evidence.

**Steps:**

1. Identify the existing functions behind `union_rakeback_log` and
   `union_pnl_settlements`. They ran on 2026-08-20, so they exist and work;
   what is missing is a caller and a period.
2. Define the week boundary explicitly (`union_rake_weekly.week_start` is a
   date, so the convention exists - confirm the timezone).
3. Schedule it **in Open Claw** (`scripts/openclaw-cron-dispatcher.py`), per
   World Hub `CLAUDE.md` section 11. **Not** `vercel.json`, **not** a GitHub
   Actions `schedule:`.
4. The job must be idempotent per period: `settlement_idempotency_keys` and
   `settlement_locks` already exist - use them, do not invent a second guard.
5. Emit a settlement report per run so a missed week is visible without a query.

**Open question for Dan:** the weeks of **08-17, 08-24 and 08-31** are
unsettled, and Phase 1 changes attribution going forward. Should those three
weeks be:

- settled on the _old_ (union-owned) attribution, as-is;
- back-attributed to the clubs first, then settled;
- or written off and the cycle started clean from the first full week after
  Phase 1 lands?

This is a real-money decision and it is Dan's, not an agent's.

**Done when:** two consecutive weeks settle automatically, with
`union_rakeback_log` showing a period exactly one week long and
`union_pnl_settlements` showing per-club results with a period matching.

**Risk:** high - it moves money between clubs and the union. Every function
must be probed inside a transaction that is **rolled back** first
(`CLAUDE.md` 11.5). Never test by settling a real week.

---

### Phase 3 - Configure `union_club_terms`

**Goal:** the risk terms the settlement model implies actually exist.

`union_club_terms` columns: `security_deposit`, `stop_loss_limit`,
`stakes_cap_bb`, `status`, `suspended_at`, `suspended_reason`, `notes`.

**Steps:**

1. Dan sets the values per club - these are commercial terms, not defaults an
   agent may invent.
2. Insert one row per member club (JAQK, Shark).
3. Wire the settlement path in Phase 2 to read them: a club past its stop-loss
   or without deposit cover is handled per Dan's rule rather than silently
   settled.

**Blocked on:** Dan providing deposit, stop-loss and stakes-cap figures.

**Done when:** both clubs have a row, and a settlement run reads and respects
them.

---

### Phase 4 - Align the multi-table caps to 4, and prove concurrency safety

**Goal:** 4 games is 4 games, enforced where it cannot be raced, and the brain
is proven safe across concurrent tables.

**Steps:**

1. **Lower the DB cap from 6 to 4** in `atomic_table_buyin`
   (`v_max_tables CONSTANT INT := 6` becomes 4). This is a
   `CREATE OR REPLACE FUNCTION` on a money path: single transaction, migration
   file, and a pasted ROLLBACK section per World Hub `CLAUDE.md` migration
   safety.
   - First check whether any player currently holds 5 or 6 seats. Lowering the
     cap must not strand anyone mid-hand; it only refuses the _next_ buy-in, but
     confirm rather than assume.
2. **Prove `pendingRaisePlan` is safe.** Establish whether every postflop path
   reaching `betSize`/`raiseTo` is dominated by the assignment. If it is,
   document it with a test that fails if a new path bypasses the assignment. If
   it is not, move the state onto the decision context (per call) rather than
   the module.
3. Only then raise the effective seating target so horses routinely sit 2-4
   tables.

**Done when:** the DB refuses a 5th concurrent cash seat; the concurrency
question is answered with a test rather than a comment; and measured
tables-per-horse rises above 1.106 without a rise in misattributed raise plans.

**Risk:** item 1 is a money-path function. Item 2 is a correctness question that
is currently unproven in either direction - do not assume it is broken, and do
not assume it is fine.

---

### Phase 5 - Reconcile table count to roster, then hold the cash distribution

**Goal:** 75% of cash tables running, in Dan's four buckets.

**This phase is blocked on a decision only Dan can make** (see 2.4): the floor
supports ~110 tables at his distribution and there are 1,134.

- **Lever A - shrink the floor.** Close empty surplus tables down toward ~110
  live. `HorseFleetManager` already has retirement machinery and a
  `MAX_TABLES_PER_CONFIG = 3` cap; the surplus closer sets `status='closed'`
  (never DELETE - the `trg_auto_cashout_on_table_close` trigger cashes out any
  remaining human seat, and a delete would strand chips).
- **Lever B - grow the roster** past 1,000 horses so 1,134 tables can be fed.
- Or a mix.

**Steps once the lever is chosen:**

1. Express the target distribution as the occupancy target, replacing the
   current per-table vibe targets in `occupancyTargetFor` (`HorseBehavior.ts`).
   That function already returns a `seatTarget` per table from a hash - so the
   four buckets are a natural fit: hash each table into one of four buckets and
   give it the matching target (full / 1-2 open / 2-4 open / empty).
2. The 25% empty bucket must be a **held-empty** state, not an accident of
   running out of horses - otherwise "empty" is indistinguishable from "broken",
   which is exactly the state the floor is in today.
3. Verify the distribution holds across an engine restart, since a restart
   releases seats (observed 2026-09-02: 204 seats to 4 across one restart).

**Done when:** a census of live cash tables lands within a few points of
25/25/25/25 and stays there for 24 hours including a restart.

---

### Phase 6 - Spins and heads-up fill rules

**Goal:** 25% running, and Dan's sign-up-and-wait behaviour.

**Steps:**

1. **Throttle to 25% running.** Spins are at 79%, heads-up at 42%. The lever is
   how many are opened and how quickly they are filled, not closing running ones.
2. **Implement the join cadence:**
   - Spins: seat 2 horses, then wait a **random 60-150s** before a 3rd joins and
     starts it.
   - Heads-up: seat 1 horse, then wait a **random 60-150s** before a 2nd joins
     and starts it.
   - The delay is per table, drawn once, not a global tick - otherwise every
     table fills on the same beat and the floor pulses visibly.
3. `spin_fill_policy.unfilled_timeout_minutes` (30) is the only existing knob
   and is a _timeout_, not a fill cadence. The new cadence sits alongside it;
   do not repurpose it.
4. **Horses Are Players (CLAUDE.md 10.5) applies.** The wait is part of the
   treatment: a human joining one of these must see the same delay behaviour. Do
   not implement the wait as a horse-only branch.

**Done when:** a census over an hour shows ~25% of spins and ~25% of heads-up
running, and the observed gap between 2nd and 3rd sign-up (spins) / 1st and 2nd
(heads-up) is distributed across 60-150s rather than constant.

---

## 4. Decisions needed from Dan

| #   | Decision                                                                                                  | Blocks  |
| --- | --------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Rake attribution by **seat** (Option A, recommended) or by **table ownership** (Option B)                 | Phase 1 |
| 2   | The three unsettled weeks (08-17, 08-24, 08-31): settle as-is, back-attribute then settle, or start clean | Phase 2 |
| 3   | `union_club_terms` values: security deposit, stop-loss limit, stakes cap per club                         | Phase 3 |
| 4   | Shrink the cash floor to ~110 tables, grow the roster past 1,000 horses, or a mix                         | Phase 5 |

---

## 5. Things that are NOT problems (do not "fix" these)

Recorded because each one has already cost an agent time this session or in the
handoff that preceded it.

- **`ca_hand_facts` looking empty for a table is not a dealing failure.** It is
  a _per-user hole-card privacy table_ and only covers humans. On 2026-09-02 it
  held 6 rows for 6 human cash hands in 24 hours - a perfect 1:1 - while
  `hand_history` recorded 2,382 hands in a single hour on the Midway micro floor
  alone. **Use `hand_history` to ask whether tables are dealing.** The previous
  handoff used `ca_hand_facts` and concluded the entire cash engine was broken.
  It was not.
- **The missing `union_clubs` row for Midway is not blocking anyone.** All 323
  Midway horse members also hold a JAQK or Shark membership; 200 of 200 tested
  resolve a wallet through `fn_seat_club_for_user` today. Inserting it unlocks
  zero horses and only re-hashes wallet attribution.
- **`union_wallets.bbj_wallet` and `.spin_reserve_wallet` reading 0** are unused
  columns, not lost money. See 2.1.
- **A `loop_ticking_no_hands` watchdog kill is not proof a table is dead.** The
  engine was dealing 164 hands in flight and 785 in the window while those kills
  were being logged.

---

## 6. How to verify current state quickly

```sql
-- Is the floor dealing? (NOT ca_hand_facts)
SELECT count(*) FROM hand_history
WHERE tournament_id IS NULL AND created_at > now() - interval '1 hour';

-- Who is rake being credited to?
SELECT COALESCE(c.name,'(null)'), count(*), round(sum(r.rake_amount),2)
FROM rake_records r LEFT JOIN clubs c ON c.id=r.club_id
WHERE r.created_at > now()-interval '1 hour' AND NOT COALESCE(r.is_tournament,false)
GROUP BY 1;

-- Cash floor shape
SELECT CASE WHEN s=0 THEN 'empty' WHEN s<=2 THEN '1-2' WHEN s<=4 THEN '3-4' ELSE 'full-ish' END, count(*)
FROM (SELECT (SELECT count(*) FROM table_seats ts WHERE ts.table_id=t.id AND ts.left_at IS NULL) s
      FROM tables t WHERE t.tournament_id IS NULL AND COALESCE(t.is_deleted,false)=false
        AND t.status IN ('waiting','running')) q GROUP BY 1;

-- Roster headroom
SELECT count(*) FROM profiles p WHERE p.is_horse AND p.horse_status='available'
  AND COALESCE(p.horse_profile->>'lane','both')<>'events'
  AND NOT EXISTS (SELECT 1 FROM table_seats ts WHERE ts.user_id=p.id AND ts.left_at IS NULL);

-- Weekly cycle alive?
SELECT period_start, period_end, total_rakeback, executed_at
FROM union_rakeback_log ORDER BY executed_at DESC LIMIT 3;
```
