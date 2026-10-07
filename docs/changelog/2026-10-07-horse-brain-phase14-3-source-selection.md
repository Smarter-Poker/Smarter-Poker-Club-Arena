# Horse Brain Phase 14.3 (plan package P14-B): the daily horse audit keeps a receipt of what it actually saw (2026-10-07)

**What was missing.** The daily gross >10BB audit (`fn_horse_commitment_audit_step`)
re-swept each closed day and zeroed its counters on every pass, so nothing
recorded which pass saw what. It had no rule for a hand that becomes visible
after its day was already swept. The batch reader showed only review rows, so
hands the audit could not read (no commit, missing or oversized payload)
were invisible. The private batch also needed a hand-written mapping from
each hand to its journal key and accepted record.

**Database** (migration `20261007075304_horse_commitment_selection_receipts.sql`):

- `public.horse_commitment_audit_passes`: an immutable receipt per (day,
  pass), written when a pass completes and before the next pass can reset
  anything. It holds the window, cutover, latest scanned time, every counter,
  hands without a commit, missing-source hands, late arrivals and the final
  cursor. Coverage is still declared `not_established`.
- The audit step is replaced through a preimage guard; its live body md5
  `45ffa0eff534e385828b0316bd4268e8` was read back from production. It
  writes those receipts, counts hands without a commit and missing sources,
  and marks a hand `late_arrival_after_pass:<n>` when the previous pass could
  not have seen it. Its return contract is unchanged.
- `fn_horse_commitment_selection_receipt(day, ...)`: a service-role reader
  returning the day state, every pass receipt and bounded pages of
  gap-only hands.
- `fn_horse_accepted_source_rows(hands)`: a service-role, read-only,
  one-snapshot reader returning exactly the accepted source row the roster
  exporter defines, with the hand number, the submission lease generation and
  the P14.2 protected roster record.

**Engine** (`server/src/services/horseDailyCorrectiveReview/`):

- The new mapping producer (`mapping.ts`, CLI `horseDailyMappingProducer.ts`)
  turns one day's reviewed hands into the manifest the batch already
  accepts, a per-hand input file and the raw rows the roster exporter
  consumes. It derives each journal key from the accepted table, hand number
  and lease generation, and pins the exact accepted journal record. It never
  writes the database, never takes a journal lease, and never supplies an
  authority. Every problem is a named pending reason.
- The daily batch reads the selection receipt and reports explicit
  `missing_source`, `late_arrival` and unreadable rows. It refuses success
  while any are open or a pass is unfinished, and still states
  `fullWindow:false` and `sourcePopulationVerified:false`.

**Verification.** `scripts/ci/test-horse-commitment-audit.py` gains a fifth
job of 58 checks. The existing 85, 24 and 27 controls are unchanged and
green. The daily regression folder passes 221 tests and the wider horse
regression set 1,328, with a clean server typecheck.

**Known limits.**

- Late arrival is proven only against the immediately previous pass.
- A hand absent from the source-row reader is reported as "missing or
  oversized"; the reader cannot say which.
- Pass receipts are never pruned.
- Classification is still the current profile until the audit adopts the
  P14.2 roster.
- References and authority remain explicit missing inputs.
