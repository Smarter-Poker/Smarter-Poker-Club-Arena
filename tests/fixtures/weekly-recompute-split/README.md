# Exact weekly recompute qualification

Run the maintained native PostgreSQL 17 entry point:

```sh
ACCOUNTING_FIXTURE_PARENT=/your/owned/external/scratch PG_BIN=/path/to/postgresql/17/bin python3 -B scripts/dev/test-union-weekly-basis.py --split-recompute-only
```

This composes the maintained original-hand, immutable earning-source and weekly-accounting fixtures. It installs the exact migration `20261003232339` after checking its real predecessor hashes, with current captured coordinator/stage dependencies bound by canonical function-definition MD5 and repository SHA256. The only calendar seam is the existing private fixture clock; financial function bodies are not mocked. Every hand enters through its original atomic commit, rake distribution and source accrual owners.

Two funded synthetic players, one human and one horse, generate 20,001 hands and 40,002 earning sources. This crosses the candidate's natural 20,000-source weighted player-page boundary without modifying page constants. The baseline and candidate each finish the current union accounting coordinator, including transfers, certificates, invoices and delivered messages. Independent arithmetic requires 20.10 rakeback per player, 40.20 union retention and an empty period rake treasury. Each completed book is fingerprinted before and after an explicit replay; a successful no-op verdict alone is insufficient.

The same finite proof expires intermediate parts by advancing the private clock thirteen hours, then immediately crashes PostgreSQL after one committed payable. Restart clears unlogged parts while retaining that payable; rebuilding must finish without duplicates. A transaction-local corrupt source is refused by both owners with zero payables, and rolls back.

The required accounting CI shard runs this entry point and retains result JSON, SQL and logs. Source-binding tests ensure relevant fixture-only changes still select the accounting check.

This is meaningful native correctness and natural-page recovery qualification, not a production-estate load test, production installation proof or a guarantee that every future workload meets its lease. It does not exercise all commission hierarchies, membership histories or tournament combinations; their maintained prerequisite fixtures retain their separate coverage. Production still requires unchanged exact preimages, the supported guarded installer and exact catalog/history readback. Existing deliberate close gates are not lifted by this fixture.
