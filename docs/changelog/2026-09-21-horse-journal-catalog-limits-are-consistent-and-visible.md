# 2026-09-21 — the Horse journal catalog limits agree, refuse before reserving, and show themselves in /health

## What was wrong

A read-only review of the Horse decision journal archive after PR #4897 found
four things that together meant a full catalog would stop capture silently:

1. **The three limits disagreed.** The catalog ceiling was 4 GiB. At the
   observed ~639 bytes of index per record that is roughly 6.7M records, but
   the writer's record cap (`maxSegments * 16`) and its corruption guard are
   both 8,000,000 records (~5.1 GB). The catalog was still the first limit
   reached, and it was reached inside SQLite, not by a named refusal.
2. **Exhaustion surfaced after the reservation.** `appendBatch` reserved the
   batch, committed, and only then hit `SQLITE_FULL` in `finishPending()`.
   That was classified UNAVAILABLE, the publisher entered `failed`, and nothing
   was logged. Capture stopped until the next restart.
3. **`storageStats()` reported the source constant** as `maxCatalogBytes`,
   not the ceiling the writer's connection had actually applied.
4. **`/health` said nothing about the journal.**

## Shipped

- **A. Consistent limits.** `HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES` is 6 GiB
  (1,572,864 whole 4096-byte pages). Derivation, in the constant's comment:
  8,000,000 records x ~640 bytes ~= 5.12 GB (4.77 GiB); 6 GiB leaves ~26%
  margin for index growth and the transient pending batch. The record cap is
  now the named `HORSE_JOURNAL_ARCHIVE_RECORDS` and the corruption guard reads
  it instead of a literal. Workload-based sizing, not a guarantee.
- **B. A named refusal before anything is reserved.** Inside the reservation
  transaction, after the existing byte and segment refusals and before the
  first write, the writer reads `PRAGMA page_count`, `max_page_count` and
  `freelist_count` and estimates the pages the batch needs: four per fresh
  record (table plus three indexes, each may split a leaf; a ceiling, not a
  measurement), the reserved compressed blob's overflow pages in full, plus a
  fixed 64-page margin. Too few free pages throws
  `horse_archive_catalog_capacity`, which `horseJournalCapacityReason` maps to
  the new finite reason `archive_catalog_capacity`; `failure.ts` classifies
  it UNAVAILABLE as before. ROLLBACK leaves no pending row, no usage charge
  and no staged file. A batch of only replayed records reserves nothing and
  is not refused. An unlimited connection (`max_page_count` 0) never refuses
  on this ground. `SQLITE_FULL` after a reservation keeps its existing
  recovery at reopen.
- **C. One log line when capture stops.** `HorseDecisionJournalPublisher`'s
  `fail()` now takes a finite reason and emits exactly one
  `console.warn('[HorseDecisionJournal] capture stopped mode=failed reason=...')`
  per publisher lifetime: the writer's named reason when it gave one, else
  which publisher fence gave up (`writer_unavailable`, `ack_mismatch`,
  `retry_exhausted`, `restart_unavailable`, `restart_failed`,
  `termination_unverified`, `shutdown_timeout`). No paths, no payloads.
- **D. The applied ceiling is reported, and `/health` carries the journal.**
  The writer reads `PRAGMA max_page_count` back after setting it and
  `storageStats()` reports it as `appliedMaxCatalogBytes` (null for a
  read-only observer, which applies no ceiling), alongside `maxRecords` and
  `maxRowid`. The worker answers a `STATS` message with those aggregates and
  never reclassifies itself over a failed probe. The publisher's `health()`
  is synchronous: it returns its cached last reply plus `mode`,
  `lastFailureReason`, `queued` and `statsAgeMs`, and asks a ready writer for
  a fresh reply at most once a second, with no timer. `handleHealth` adds a
  `horseJournal` section from `horseDecisionJournalHealth()` (null, and so
  no section, when no journal is configured). The section never moves the
  HTTP code: a stopped journal is a diagnostics gap, not a routing verdict.

## Proof

- `server/src/services/HorseDecisionJournal.test.ts`: the writer refuses a
  batch by name with a tiny `max_page_count` and leaves no reservation, no
  file and an unchanged hand; the real `SQLITE_FULL` recovery test keeps its
  post-reservation exhaustion by giving the pre-check room and the trigger
  none; the headroom test asserts the 6 GiB pragma, the read-back
  `appliedMaxCatalogBytes` and the observer's null; the real worker answers
  `STATS`; the publisher logs exactly one line with the reason, names the
  fence when the writer did not, answers health from cache, throttles
  requests and treats a STATS reply as neither an ACK nor a failure.
- `server/src/handlers/health.test.ts`: the section is carried on a 200 and
  omitted when null.
- `cd server && npx tsc --noEmit`; `npx vitest run src/services/horseDecisionJournal
src/services/HorseDecisionJournal.test.ts src/handlers/health.test.ts
src/engine/horseDecision/workerLifecycle.test.ts`.

## Deliberately not changed

- The 8 GiB compressed allocation, 500,000-segment cap, 8,000,000-record cap,
  8-day Horse-only hand retention, schema version, durability pragmas,
  private-path checks and read bounds.
- No timer, watcher, cron or repair loop was added; `/health` asks, it does
  not wait, and a reply that never comes shows as a growing `statsAgeMs`.
- No production, Supabase, migration or release-lane change. The larger
  catalog is applied by the next writer open; an older engine with the 4 GiB
  limit cannot reopen a catalog that has grown past it, as the 2026-09-18
  entry already records for the previous raise.
