# Tournaments stopped starting

2026-09-09. Branch `fix/tournaments-stopped-starting`.

Every number below was read from `tournaments`, `tournament_launch_receipts`,
`hand_history`, `supabase_migrations.schema_migrations` and the engine's own
container log. Nothing is inferred.

---

## What a player saw

From 17:25 UTC no tournament launched. The last tournament hand was dealt at
18:11. By 20:5x there were 21 launches claimed and none completed, 379 events
past their advertised start, and buy-ins sitting in escrow for all of them.
Cash games never stopped.

## Three causes, in the order they were found

### 1. Two composite foreign keys made PostgREST refuse every seat embed (17:25 to 20:55)

`20260909172447` and `20260909172529` (another programme, correct in intent)
added two COMPOSITE foreign keys from `table_seats` to `tables`:
`active_seat_game_scope_parent (table_id, active_game_scope)` and
`live_seat_parent_cannot_close (table_id, active_parent_key)`. With the
original `table_seats_table_id_fkey` that is three relationships, and PostgREST
discovers relationships from `pg_constraint` alone. From that minute every
hint-less embed between the two tables answered PGRST201:

    Could not embed because more than one relationship was found for
    'table_seats' and 'tables'

Eleven such embeds exist on main across the engine and the client. The one
that mattered is the launch's live-seat inventory read in
`createTablesAndSeatPlayers` (`tables!inner(tournament_id)`): every launch
claimed its receipt, threw on that read before building a table, and left the
event in REGISTERING.

**Fixed inside the 20:55 break** by three migrations that keep both invariants
and remove the ambiguity. The composite keys became triggers with FK semantics:
same error class (23503), same constraint names (the other programme's tests
match on them), MATCH SIMPLE, `FOR KEY SHARE` on the parent row, cascade on
scope change, refusal of a close over a live seat. Rolled-back probes found two
defects in my own first shape before any live write met them, hence three
files:

| version          | what                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260909205508` | drop both composite keys; seat-side and table-side guards; assert exactly ONE FK remains                                                                                                                                                                                                                   |
| `20260909205646` | the cascade ran in a BEFORE trigger and read the parent's OLD scope, so it refused itself. Moved to AFTER, where a real FK cascades                                                                                                                                                                        |
| `20260909205854` | `UPDATE OF <column>` fires on the statement's column list, and both keys are DERIVED by stamp triggers (`cluster_id` -> scope, `status` -> admission key), so neither guard ever fired. Both now fire on values (`WHEN OLD IS DISTINCT FROM NEW`); the seat guard renamed `zzzzz_` to sort after its stamp |

Verified before the engine came back: the engine's exact embed returns
`HTTP 200 []` through PostgREST; wrong-key seat writes are refused with the
original constraint name; a close over a live seat is refused; a real
`cluster_id` change cascades; ordinary seat writes are unaffected. After the
engine restarted at 20:55 the PGRST201 count in its log went to zero, and at
21:04:47 fourteen events launched in one discovery pass. By 21:12 tournament
hands were back at 63 a minute across 15 events.

The three files in `supabase/migrations/` are byte-identical to
`schema_migrations.statements` (md5 checked). Pinned by
`tests/one-relationship-between-seats-and-tables.law.test.ts`: the trigger
shapes, and that no later migration adds a second FK between the two tables or
drops the triggers.

### 2. The database demanded a lock the running engine does not take (20:54 to 21:55)

At 20:54:12, one minute before my break window, PR #3716 (another programme)
was applied as `20260909205412_spin_reserve_settlement_commits_its_journal_or_nothing`.
It installs `a0_tournament_live_seat_root_guard`: a BEFORE trigger on
`table_seats` that refuses any live tournament seat write unless the
transaction already holds the `ca:tournament-terminal-settlement:v1` advisory
lock, which only its new `fn_assign_tournament_player_seat_atomic` family
takes.

The engine that satisfies it is in the same PR. But a migration applies the
moment its PR merges, and the engine ships at the next `:55` - and every deploy
run between 20:10 and 20:51 was cancelled as pending by the next merge (that is
how `concurrency.cancel-in-progress: false` behaves: the newest pending run
wins). So the 20:55 cutover shipped `561eaa52`, merged 19:54, whose launch
still does a raw `table_seats.insert`. From 20:55 every MTT launch got as far
as its first seat and was refused:

    Failed to seat a354ec75: TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY

Heads-ups launched because their two seats already existed ("Adopted 1
existing table, seating the remaining 0"). MTTs did not.

No change of mine closes this window; the run that carries #3716
(`877bea76`, in progress since 21:12:57) ships at the 21:55 cutover, and the
launches that stood down are re-admitted by the next discovery pass. It is
recorded here because it is the general shape of an outage this repo will have
again: **a guard that refuses a write the RUNNING engine makes is an outage
for up to sixty minutes, and the gap is invisible to every test, because the
tests run the engine that satisfies it.** The same PR also gave every
tournament seat acquisition platform-wide one global exclusive advisory lock;
the 21:00 thaw produced 276 `seat_first_seat_rpc_failed: lock timeout` in two
minutes as every board's fill queued behind it. That is #3716's design and not
changed here; it is named so the next reader of those alerts knows where they
come from.

### 3. A Free Buy that sits down late could never launch (engine, fixed here)

Once launches ran again, one class stood down every pass:

    [Tournament.addon_period_open_failed] the requested add-on window does not end after it starts
    [Tournament.free_buy_addon_open_unproven] ... standing down before dealer admission

`triggerAddOnPeriod` anchored the Free Buy window to the ADVERTISED start:
`end = start_time + late_reg + break`. Right on time (the pre-seat minute runs
a minute early, so the break lands on the advertised clock). Wrong for a field
that sits down late: every Free Buy on the board was hours past
`late_reg + break`, so `end < now`, the open threw, `start()` stood down before
dealer admission, and the next discovery pass did exactly the same thing.
Ten events - Morning, Midday, Afternoon, Prime Time and Midnight Free Buys -
1,143 paid entrants (read at 21:24), permanently unlaunchable.

The anchor is now the LATER of the advertised start and the moment the field
actually sits down. On time nothing changes. Late, the players get the same
late-reg-plus-break window they were promised, counted from the seat, which is
what "add on as soon as they sit down, and also at the break" says.
`FreeBuyAddOnLifecycle.guard.test.ts` pins the new anchor and still forbids the
seat-alone anchor that would move an on-time break off the advertised clock.

## What is still open after this branch

- The 232 events REGISTERING past their start at 21:09 are mostly on-demand
  boards waiting for players (128 spins, 56 sit-and-gos, 8 satellites, average
  0.3 players). The 46 MTTs among them are the outage; 44 hold a full field
  and launch as soon as the engine can seat (cause 2, 21:55) - the Free Buys
  once this branch ships.
- `late_reg_seat_reuse_failed: TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY`
  is cause 2 on the late-registration path and closes with the same deploy.
- `bounty_elimination_claim_failed: invalid_claimants` (140 in ten minutes) and
  `mystery_bounty_pay_failed: mismatched obligation generation` predate today
  and are not this outage; they are named so nobody reads them as its residue.
