# The attestation covers the journal, not the last eight days

2026-09-07. Migration `20260907164321`, branch
`fix/the-attestation-covers-the-journal`.

This is the deep dive over phase 6, which merged four hours earlier as #3456.
It found three defects in that work. All three are the same shape, and it is
the shape CLAUDE.md 10.86 names: **a component that answers confidently about a
scope nobody stated.**

## 1. "8 days checked, 0 drifted" was a true sentence about 23% of the journal

`chip_ledger` holds legs on **35 days** before today. Eight carried a manifest.
The other twenty-seven - 2026-03-19 through 2026-08-29, **176,140 legs, 8.8% of
the journal** - were attested by nothing, and never would have been:

- `fn_ca_ledger_day_manifest` only ever examines `CURRENT_DATE - 1`, so it
  cannot reach backwards;
- `fn_ca_ledger_day_manifest_verify_all` iterated the **manifests**, so a day
  with no manifest was not an unchecked day to it. It was not a day at all.

So the function returned `{"checked": 8, "drifted": 0}` and there was nothing
in that answer a reader could use to notice the other twenty-seven. Phase 6 was
written because an attestation that nobody re-reads is a photograph. This is
the same failure one level up: a re-reading that covers a quarter of the
subject and reports like it covers all of it.

**Fixed at the root** (10.11), not detected:
`fn_ca_ledger_day_manifest_backfill(p_since date DEFAULT NULL)` attests every
_finished_ day the journal has that carries no manifest, so coverage follows
the JOURNAL rather than the date the cron happened to start. It composes no
manifest itself - it calls the writer, once per missing day - which is what
keeps the number of places that know how to hash a day at **two**, the pair the
law already pins as identical.

The verifier now also counts the days it could NOT check and returns
`unattested` and `unattested_days` beside the drift count, and raises a
critical incident when that count is non-zero. `0 drifted` can no longer be
read as full coverage, because the coverage travels with the answer.

## 2. The verifier's cost was O(days x journal), against a journal kept for ever

Measured, not guessed. The old verifier opened **one sequential scan of
`chip_ledger` per day**: 9,463 ms for eight days, 1.18 s each, on a
2,004,587-row table that has no index on `created_at` alone (seven composite
indexes lead with `club_id` or an entity id).

At 35 days that is 41 s. Dan ruled on 2026-09-07 that every leg is kept for
ever, so at a year of retention it is seven minutes, for a job with a statement
timeout. **It would never have failed loudly.** It would have got slower until
something killed it, and a verification that has stopped running is
indistinguishable from one that finds nothing - which is precisely the state
2026-08-31 sat in for six days.

The recompute is now **one pass** with `GROUP BY`, so the cost is proportional
to the journal and no longer multiplied by the days retained.

|                          | days | measured      |
| ------------------------ | ---- | ------------- |
| before, one scan per day | 8    | 9,463 ms      |
| before, extrapolated     | 35   | ~41,000 ms    |
| after, one pass          | 35   | **11,683 ms** |

It is a `FULL JOIN`, not a loop over either side, because both directions are
real failures: a day whose rows changed, and a manifest whose day has lost all
its rows.

## 3. The strongest alarm in the system had no reader of its own

`scripts/ci/anchor-ledger-days.mjs` exits 1 when a day already carried by
`docs/attestation/chip-ledger-days.tsv` hashes differently in the database and
no restatement explains it. That is the loudest thing this subsystem can say:
_the journal's history changed and nothing accounts for it._

It reached a person only as `check-main-is-green` eventually reporting **"Schema
Manifest Refresh has been red for six hours"** - indistinguishable from a
manifest-refresh hiccup, and **masked entirely** whenever any open issue already
named that workflow, because that detector matches on the WORKFLOW name and
this workflow has three jobs.

The `definer-exposure` job, in the same file, already solved this and says why
in a comment: _"A red job in a scheduled workflow is a tree nobody hears fall.
The finding has to arrive somewhere a person looks."_ The anchor did not copy
it. It does now: a named issue on failure, with the script's own output in the
body and the instruction not to edit the file, and a step that closes the issue
when the anchor agrees again. CLAUDE.md 10.86 rule 3 - a guard must have a
reader, and you must name them. The reader is that issue.

## What is live

```
verify_all() -> {"checked": 35, "drifted": 0, "unattested": 0,
                 "unattested_days": [], "ms": 11683}
manifests      35 days, 2026-03-19 .. 2026-09-06
cron 181       SELECT fn_ca_ledger_day_manifest();
               SELECT fn_ca_ledger_day_manifest_backfill();
               SELECT fn_ca_ledger_day_manifest_verify_all();   (25 4 * * *, unchanged)
anchor file    36 lines - a header and 35 days
incidents      0 manifest incidents, 1 restatement (2026-08-31, from phase 6)
```

No new scheduled trigger anywhere (10.85): the same pg_cron job that has run at
04:25 since the manifests existed, and the same two workflow crons.

## Proved, not assumed

- The single-pass recompute was run as a plain `SELECT` against production
  **before** any function was replaced, and agreed with the old per-day loop on
  all eight days it could be compared against: 8 attested, 27 unattested, 0
  drifted, 0 manifests without rows.
- The migration's own `DO $verify$` aborts on: a finished day with no manifest,
  a manifest naming a day the journal does not have, any drift, any unattested
  day the verifier reports, a coverage field missing from the answer, the
  writer and verifier hash expressions differing **read from the catalogue**,
  the daily job having lost any of its three calls, and either function being
  executable by `anon` or `authenticated`.
- The anchor was run against the newly-covered database: 27 lines appended, and
  a second run says `up to date: 35 day(s) anchored, nothing new` (exit 0).
- Tampering with an anchored line for 2026-04-14 - one of the days that only
  became anchorable today - exits **1** with `A DAY THAT IS ALREADY ANCHORED
NOW HASHES DIFFERENTLY`. The file was restored byte-identical afterwards.
- 17 law assertions in
  `tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts`, including
  one that fails if the per-day loop ever comes back.

## What an anchored day does and does not prove

Worth stating plainly, because this change anchors days going back to March.
Hashing 2026-03-24 today proves **nothing** about what that day held in March.
It proves that from today onward that day cannot change without the change
being visible - inside the database by the verifier, outside it by a file git
owns. Since every leg is now kept for ever, that is the guarantee worth having:
history not being rewritten later. `docs/attestation/README.md` says this in
the same words, next to the file itself.

## Still open, and not mine

- One unbanked raked hand (7.50, `56d12749`) that `fn_bbj_repair_unbanked`
  structurally cannot fix, because it reads FROM `rake_records`.
- 364.80 still owed across three tournament winners, pending Dan's
  bubble-protection funding decision.
- Only 1,611 of 2,004,587 legs carry an idempotency key (0.08%). Flagged in the
  phase 5 partition plan; not started.
