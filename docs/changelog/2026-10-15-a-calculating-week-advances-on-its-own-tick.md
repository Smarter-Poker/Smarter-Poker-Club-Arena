# A Calculating Week Advances On Its Own Tick (2026-10-15)

## What Happened

The original week (union fade0000, 2026-10-05 to 2026-10-12) sat in stage `calculating` from 15:26 to 17:13 UTC. Its two clubs (a0000000 and a41434bb) each needed their split recompute (`fn_rakeback_recompute_split`): 1 players part, 28 tournament-gate parts, 84 count parts, then one check and one write part per player page.

From 15:26 to 16:30 the week gained 2 parts. The 16:10, 16:15 and 16:19 scheduler visits all ended `weekly_scope_statement_budget_exhausted` and kept nothing. Parts expire 12 hours after the oldest one, so the week could never finish.

## Cause (Measured)

- Job 272 ticks were sampled every 0.5 s through `pg_locks` at 16:25 and 16:30 UTC.
- Before the union attempt reaches the split, each tick spends 60 to 90 s on the scheduler eligibility scan and the standalone club (Deep Stack Society) visit. In 100 of 115 one-second samples the tick was waiting on `IO:DataFileRead`.
- The attempt's preparation then spends about 50 s more, measured warm:
  - cash refusals: 11 s;
  - P&L close quality: 28 s;
  - week clubs: 9 s.
- A cold part takes 20 to 60 s. Each 240 s tick therefore had room for one part at most.
- A part that ran past the statement timeout rolled the whole attempt back, along with every part it had computed.

## Settlement Of The Stuck Week

The split was called directly with job 272's chunked settings, so nothing ran in front of each part. Neither club-week was blocked:

| Club | Calls | Result | Written | Request row |
| --- | --- | --- | --- | --- |
| a41434bb | 18 | ready | 303 | 34ad55c6 |
| a0000000 | 13 | ready | 392 | 7e405939 |

The 17:30 tick reused both receipts, and the run moved to stage `prepared`.

## Fix

Migration `20261015173123_a_calculating_week_advances_on_its_own_tick.sql`:

- **New function `fn_accounting_split_advance_due()`.** While any closed club-week is part way through its split, it advances those parts (oldest first) inside a chunked tick.
  - Each club-week gets at most the split's own 90 s.
  - No part is started with less than 90 s of the statement left (75 s is held back for the longest measured part plus the commit). The parts it starts therefore always commit.
  - A club-week that finishes blocked files one open critical `financial_alerts` row per club-week.
- **Patch to `fn_process_weekly_accounting_scope`.** The top-level chunked tick calls the advance before any scope scan. When it advanced, the tick visits no scope, the same way a tick that is still sealing inventory visits none.
  - Preimage md5 (pg_get_functiondef): `e6960e39…`. Postimage: `a4973812…`.
- `fn_rakeback_recompute_split` itself is unchanged (guard md5 `6b2a9c08…`).

Law: `tests/a-calculating-week-advances-on-its-own-tick.law.test.ts`.
