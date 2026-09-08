# The journal retention and archive policy

**Roadmap 9.4. Written 2026-09-08. Every number measured that morning.**

`chip_ledger` is the record of every chip that has moved. Nobody had written
down how long a leg is kept, what happens to it when it ages out, or where it
goes — and **a journal that can be silently dropped is not a journal.** This is
that rule.

## What is actually there, today

|             |                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------- |
| legs        | **2,356,797**                                                                                |
| oldest leg  | **2026-03-19** (173 days)                                                                    |
| new legs    | **353,008 in the last 24 hours** — the roadmap measured 232k on 09-02, so the rate is rising |
| size        | **1,995 MB**, about 0.85 KB a leg → **~300 MB a day, ~9 GB a month**                         |
| partitioned | **no.** 8.4 plans the cut; it has not happened                                               |
| attested    | `ca_ledger_day_manifests`, 36 days, 2026-03-19 to 2026-09-07, one sha256 a day               |

At this rate the journal passes 10 GB before December and doubles roughly every
seven weeks. That is the pressure this policy exists to answer **before**
somebody answers it by deleting rows.

## The rule

### 1. A leg is kept for seven years, and the number is not a guess

Seven years is the retention the regulated rooms this platform is modelled on
work to (GLI-19 and the NJ DGE regime the hierarchy audit was drawn against).
It is longer than any dispute window, any tax year, and any plausible
investigation. **Nobody may shorten it to reclaim space.** Space is answered by
section 3, not by forgetting.

### 2. Hot, warm, cold — and the boundary is the epoch, not a date

- **HOT — the current epoch.** Every leg of `ca_financial_epochs.is_current`
  stays in `chip_ledger`, online, indexed, replayable. The conservation meters,
  `fn_ca_ledger_replay` and every player's own statement read from here. No
  ceiling: an epoch that grows large is a reason to close an epoch, not to trim
  one.
- **WARM — a closed epoch, still online.** Legs of an epoch with `ended_at`
  set move to `chip_ledger_archive`, same columns, same row for row. Still
  queryable, still exportable, no longer scanned by the nightly meters — which
  is where the cost actually is, since every meter is O(journal).
- **COLD — beyond the warm window.** A closed epoch older than **thirteen
  months** may be exported to object storage as one file per day, and only then
  removed from `chip_ledger_archive`.

The epoch is the boundary because a reset already draws that line (9.8), and
because a leg's meaning depends on the epoch it belongs to. Splitting on a bare
date would cut an epoch in half and make its opening balance unreadable.

### 3. Space is answered by partitioning, never by deleting

The cut in 8.4 partitions `chip_ledger` by month. Once it lands, the warm move
is `ALTER TABLE ... DETACH PARTITION` and an attach to the archive: a catalogue
operation, seconds, no row rewritten and no row lost. **Until that cut lands,
nothing ages out of `chip_ledger` at all** — a `DELETE` of a million legs to
reclaim space is precisely the silent drop this policy forbids, and it would
break `fn_ca_ledger_replay` for every account it touched.

### 4. Nothing leaves without its attestation, and the attestation outlives it

A day's legs may only move — warm or cold — when
`ca_ledger_day_manifests` holds that day's row: `row_count`, `first_seq`,
`last_seq`, `net_amount`, `sha256`. **The manifest is kept for the full seven
years regardless of where its legs are**, and it is small enough that this
costs nothing: 36 rows for 173 days today.

That is what makes an archived day checkable. Re-hash the exported file, compare
to the manifest, and a silent alteration in cold storage is detectable by
anybody who has the manifest — which is also why 9.2 anchors the daily sha
outside this database.

### 5. Nothing is removed while it is owed

A leg may not be archived or exported while it is still referenced by an
unresolved obligation: an open `financial_alerts` row, an unsettled
`tournament_escrow`, a `pending_fee_distributions` row, or an unclaimed
`agent_commissions` row. The move is refused, not deferred silently, and the
refusal names the row that is holding it.

### 6. One writer, and it says what it did

Ageing happens in exactly one place, on a schedule, and it writes a row per run
naming the epoch, the day range, the row count and the sha it verified. A move
with no record is indistinguishable from a loss. Per CLAUDE.md 10.85 that
schedule is pg_cron or Open Claw — **never the Claude scheduler**.

## What this policy does NOT decide

- **When an epoch closes.** That is 9.8 and it is Dan's.
- **Where cold storage lives.** Naming a bucket is an infrastructure decision
  with a cost attached; this says only that cold storage must be outside this
  database and must be verifiable against the manifest.
- **`hand_history` retention**, which is separate, already has a policy
  (`hand_history_retention_policy`, 7 days for horse-only hands), and is Dan's
  per CLAUDE.md 10.5. This document is about the money journal only.

## Status

**The policy is written; none of it is built.** Sections 2, 3 and 6 need the
8.4 partition cut first, and that cut should now be built to this shape rather
than to a storage target. Section 4's manifest already exists and already runs.
Section 5 is a check that can be written today and should be, before anything
moves.
