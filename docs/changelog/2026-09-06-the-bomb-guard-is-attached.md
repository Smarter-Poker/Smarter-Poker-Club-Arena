# 2026-09-06 - The bomb guard is attached, now the engine can satisfy it

Chip-accounting programme, phase 2 of 9 (`docs/CHIP-ACCOUNTING-ROADMAP.md`
Part Two). Phase 1 (PR #3272) made the engine write a bomb-pot hand and its
award units in one transaction. This phase makes the database refuse the
alternative.

## What shipped

**Migration `20260906143315_the_bomb_guard_is_attached_now_the_engine_can_satisfy_it`**
(applied to production 14:37 UTC, file and applied text at byte parity).
Attaches `fn_ca_bomb_hand_keeps_its_award_units()` - defined 2026-09-06 by
`20260906100735`, detached the same morning by `20260906101230` because the
engine could not yet obey it - as constraint trigger
`zz_ca_bomb_hand_keeps_its_award_units` on `hand_history`, `DEFERRABLE
INITIALLY DEFERRED`, bomb rows only. A bomb hand that distributes chips now
cannot commit without award units summing to the distributable pot.

**Law `tests/a-bomb-hand-cannot-commit-without-its-award-units.law.test.ts`**
pins: the attach comes after the detach; the trigger is deferred; the DDL is
guarded; the migration proves itself both ways; no later migration drops the
guard except a named rollback; nothing in `server/src` sets constraints
IMMEDIATE.

## Why now, measured before touching anything

Every number is from production at 14:30 UTC, read with the raw query in the
handoff's Part 9 (the detector `fn_bomb_pot_ledger_gaps` under-reports and was
not used):

- #3272 merged 12:28 UTC. The engine restarted with it at the 12:55 break
  (per-minute hand count: 5 at 12:54, 262 at 13:00).
- Since 12:58: **397 bomb hands, 0 without units, 0 whose units do not sum
  to the pot.** The last unit-less bomb hand is 12:47:27, before the restart.
- Trailing 7 days: 26,448 bomb hands, 5 unit-less (all pre-restart), 0 sum
  mismatches ever.
- Atomicity in the rows: for the 248 bomb hands in the preceding hour, every
  award unit carries the same `xmin` as its `hand_history` row.

Ten minutes after attach: guard live, bomb hands committing (12 in the two
minutes before the reading, last one a second old), 0 gaps, 0 probe residue.

## The migration proves itself, and the first draft failed its own proof

The migration calls `fn_ca_insert_hand_with_awards` three times inside
subtransactions it rolls back: a distributing bomb hand with no units must be
refused with SQLSTATE 23000; the same hand with units summing to 10.00 must
be accepted; a folded-around bomb (nothing to distribute) with no units must
be accepted. It aborts itself if any disagrees.

The first draft set `SET CONSTRAINTS ... IMMEDIATE` _before_ each call, and
the migration aborted at 14:36 on probe 2: with IMMEDIATE, the trigger fires
at the end of the hand `INSERT`, which inside the RPC is one statement before
the units `INSERT`, so the atomic write itself was refused. Nothing committed;
the abort is the design. The probes now call the function under DEFERRED and
set IMMEDIATE afterwards, which checks the outstanding events retroactively -
the same moment production checks them, without a COMMIT.

That is worth more than the probe. It says the rule only holds because the
trigger is deferred to commit. Anyone who runs `SET CONSTRAINTS ALL IMMEDIATE`
around a hand write (a psql session, a future engine change) refuses every
bomb hand the RPC writes. The law pins `server/src` against it and the
migration header says so in words.

## What else this session established

- **TASK A held both directions.** After the 13:35 notification gate: 0 new
  `fn_ca_escrow_on_close` incidents, 0 pages, 2 `notify_withheld` rows (both
  0.00 criticals). A rolled-back probe filing a 4,321.10 critical returned
  `sent=1 withheld_rows=0 notification_rows=1` - a real critical still
  reaches a person. `fn_raise_notification` is a row insert into
  `notifications`, so the probe's rollback left nothing behind (verified).
- **TASK B was already done, and the check that said otherwise was the wrong
  instrument.** `6f1a454f93` (the RIT test-speed fix) is not an ancestor of
  `origin/main` because #3272 was squash-merged: `git merge-base --is-ancestor`
  can never see a squashed commit. `git log -S 'allInStreetRevealMs = 1'`
  finds the content in `f33035d32b`. A cherry-pick onto a fresh branch came
  back empty. The temporary branch was deleted before any PR opened. Lesson
  for the handoff: after a squash, test for the CONTENT, never the SHA.
- The `/tmp/felt/apply_v.mjs` and `/tmp/export-one.mjs` helpers the handoff
  relied on were gone with the previous session. Re-created; both record and
  read `supabase_migrations.schema_migrations` under the file's exact version.

## Rollback

If bomb hands stop committing: `SET lock_timeout='9s'; DROP TRIGGER IF EXISTS
zz_ca_bomb_hand_keeps_its_award_units ON public.hand_history;` then a
follow-up migration saying it is the rollback and why. The law requires the
word.
