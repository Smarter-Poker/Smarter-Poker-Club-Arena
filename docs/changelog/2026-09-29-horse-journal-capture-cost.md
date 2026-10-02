# The Horse decision journal still shed on fa480b9b: the writer cost too much CPU, ran at nice 10, and the queue held fifteen seconds

Date: 2026-09-29. Owner lane: Phase 6A/6B/6D final live evidence on `fa480b9bb99132938aabc7788810e5df5b0bf056`.

## What was measured

Release fa480b9b (container started 2026-09-28T21:06:27Z) contains #5541 (one archive catalog per decision-shard writer). Read from `public.horse_brain_flush_receipts` (`source_release like 'fa480b9b%'`, 21:06Z to 03:08Z, 15-minute bins, `docs/evidence/phase6d/capture-health-2026-09-29-fa480b9b.json`): `phase15_journal_queue_capacity` is non-zero in 23 of 25 bins, 316,686 refusals against 2,907,785 enqueued (9.8% of offered overall, up to 22.3% in a 15-minute bin), `phase15_journal_lock_retry` is zero in every bin, and `phase15_journal_capture_unavailable` totals 57,554 in bursts. #5541 removed the lock contention and did not remove the shed. The capture gates (G5, G6) cannot be verified on a journal that refuses a tenth of what it is offered, so the evidence run was stopped and the cause was fixed instead.

## Root cause, three parts, each read from the running host or reproduced locally

1. **The writer validated every segment five times.** A 16-record batch was decoded as built, as reserved in the catalog, as staged, as published, and once more from the catalog, and each decode re-parsed and re-canonicalised every record: 5 validations and 15 canonical serialisations per record, measured with counting mocks on a representative batch. Writer CPU per batch was about 20 ms on the host (10 to 12% of a core at about 6 batches a second, read from `/proc/<pid>/task`).
2. **Both writer threads ran at nice 10.** A Linux thread inherits the priority of the thread that creates it. The decision worker lowers itself to nice 10 at its first line (`workerPriority.ts`) and then created the journal writer, so on a 4 vCPU host at load about 12 each writer had about a tenth of a core, about a thousand involuntary preemptions a second, and a ceiling of about 100 records a second against about 120 offered to each shard. The engine container has no CAP_SYS_NICE, so a thread cannot raise itself back.
3. **The queue held about fifteen seconds.** #5541's bound (4,096 records / 16 MiB) was justified as "a few hundred bytes a decision". A decision record is about 9,000 bytes (8,853 and 9,146 decoded bytes per record in the two live archives), so 16 MiB held about 1,800 records, the count bound never applied, and any stall over fifteen seconds shed. Its throughput test used 100-byte payloads and could not see this.

## The changes

- `store.ts`: a segment's validation is a pure function of its bytes and its digest is the sha256 of those bytes, so a digest that has passed is remembered (bounded, 256) and its records are not validated again. The digest is still recomputed from the bytes actually read on every decode, so changed bytes on disk are still refused. `appendBatch` serialises each record once. `worker.ts` drops its duplicate validation loop.
- `HorseDecisionJournal.ts` and `horseDecision/worker.ts`: the decision worker creates the journal writer before it lowers its own priority (`prespawnHorseDecisionJournalWriter`), and `startHorseDecisionJournal` adopts that writer for its shard; a writer made for another shard is terminated, never reused. The queue bound is 8,192 records / 64 MiB, about a minute of the measured offered rate at real record size.
- The three Phase 6 review tools (`phase6b-route-proof.mjs`, `phase6d-population.mjs`, `phase6d-chain-export.mjs`) opened `archive` (shard 0) only. Since #5541 a hand lives in exactly one of `archive`, `archive-shard-1`, so half of the fleet's hands, producers and receipts were never observed and nothing said so. They now list the shards with `horseJournalArchiveDirectoryNames` and walk every one; the reports carry a `shards` block.

## Pinned by

- `theWriterValidatesEachRecordOnce.test.ts`: red on the previous store (80 validations and 240 serialisations for one batch; green at 16 and 32), plus a changed-bytes-still-refused case.
- `theQueueOutlivesAStallOfRealRecords.test.ts`: red on 16 MiB (holds 1,904 of 7,200 records), green on 64 MiB.
- `theJournalWriterIsNotBornNice.test.ts`: the kernel property on real threads (Linux), the call order in the decision worker, and the adoption.
- `theReviewToolsReadEveryArchiveShard.law.test.ts` (registered in `docs/laws.d/`): red on the three tools as they were, green on a two-shard fixture.

## What is not claimed

Nothing here is verified on a serving release. The fix is delivered to `main`; it reaches engine-01 through `stage-engine-release.yml` and `auto-deploy-hetzner.yml` in a certified maintenance window. Until a release containing it serves and its own receipts show `phase15_journal_queue_capacity` near zero, G5 and G6 for 6A, 6B and 6D stay `defective` and the population, replay and route proof are not run on it. A writer that the journal restarts is created from the (niced) publisher thread and is still niced; that degraded path is named, not fixed here.
