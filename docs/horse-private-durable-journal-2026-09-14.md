# Private Horse decision journal

The Horse worker now has a real private disk producer for decision inputs, original read frames, sampled outputs, random states, execution witnesses and accepted-hand observations. An isolated journal worker commits immutable records to a local SQLite spool. A bounded reader can recover the same records after the producer exits. This implements local durable capture; it does not establish complete capture, full replay, a GTO verdict or publication.

## Producers and durability

`HorseDecisionWorkerRuntime.executeFast` records the validated snapshot, private original read frame, selected decision, retained plan effects, before/after RNG, compute/governor metadata and current solver readiness. The deep path records its original read frame and random states. Both mark runtime pins incomplete because store counts and the current artifact description are not the full historical runtime packs, effective work or timing gates needed for complete replay.

The actual client registers a private finalizer on returned execution witnesses. The scheduled executor's terminal receipt, including coerced and abandoned outcomes, enters the same worker FIFO as `OBSERVE_EXECUTION`. Its ACK means FIFO acceptance. The existing accepted-hand observation separately enters the journal after the authoritative hand transaction accepts it. Hashes of the exact hand coordinate and original request identity relate these records; canonical hand/action reconciliation retains the strict prefix, executor and producer-lineage checks from the previous batch.

`HorseDecisionJournalPublisher` serializes immutable JSON before transport and retains each admitted record until an exact ordered disk acknowledgement arrives. Up to sixteen queued records share one transaction. Every acknowledgement binds the event ID and digest of the entire record, including source, producer, sequence, time, kind, hand/turn coordinates and payload. Duplicate IDs with different bytes are refused. A conflict in the last record rolls back the whole new batch, including quota accounting. The gameplay/FIFO ACK is never treated as a disk ACK.

SQLite runs only in the private journal worker. No filesystem or database operation is added to HorseLogic's synchronous decision call or the engine executor. Capture/transport, disk failure, queue capacity and shutdown uncertainty have distinct finite `phase15_journal_*` receipts. The writer has a five-second progress deadline and bounded shutdown. Failure leaves capture unavailable without restarting the game engine or deleting old evidence.

## Configuration, privacy and bounds

The native deployment must explicitly provide `HORSE_DECISION_JOURNAL_DIR` on a qualified durable private host mount. It is unset by this change. An unconfigured process emits the disabled receipt and adds no execution-journal FIFO jobs. No infrastructure, container definition, dependency installation or Supabase schema was changed.

The implementation uses Node's built-in SQLite module. Local verification used Node 22.23.2 on macOS arm64. The installed Linux runtime, filesystem/mount durability and sustained throughput still require qualification before configuration is enabled. Unsupported runtime or storage fails capture explicitly.

The directory must belong to the process user and deny group/other access. The database must be a private regular file with one hard link; symlinks and foreign schemas are refused. Files are created with mode0600 inside mode0700. SQLite uses rollback journaling, synchronous EXTRA, fullfsync where supported and a250ms isolated lock wait; the required settings are read back. The implementation follows the [SQLite durability settings](https://www.sqlite.org/pragma.html#pragma_synchronous), but hardware/power-loss and Linux qualification are not inferred from those settings.

Limits are512KiB per portable record,64 queued records/4MiB,16 records per write transaction,100,000 retained records/64MiB logical bytes and128MiB database pages. Rollback-journal space is additional and must fit the qualified mount. No automatic deletion or unreviewed replacement is implemented. A full spool refuses further capture explicitly; it cannot certify a complete daily population. Hand reads refuse more than256 records or8MiB within one read transaction, checking sizes before materializing the JSON bodies.

Private cards, read frames, actor/hand identities and journal payloads never enter public table state, health, telemetry counters or ordinary decision replies. The private journal port carries them only to its owning disk worker. Public counters contain finite outcome labels. Source release identity remains null when the process cannot establish it.

## Verification and remaining work

Storage tests use actual native SQLite transactions for restart/readback, lost acknowledgement followed by exact replay in another Node process, conflicting IDs, competing connections, lock refusal/recovery, atomic quota accounting, batch rollback, corruption, private modes, symlink/foreign-schema refusal and bounded reads. Publisher tests distinguish admission from exact ordered disk acknowledgements, immutable queued input, failures, queue pressure and bounded shutdown. Actual client/worker fixtures exercise finalizer-to-FIFO transport, fast/deep private capture, unchanged strategy sampling and preserving a valid decision when capture fails.

A separate native proof ran an actual validated NLH reference decision through the real journal publisher and disk worker. After draining and closing that writer, a fresh process read three disk records, matched the execution witness to its accepted hand/action, restored the recorded read frame/RNG and reproduced action, amount, think time and final RNG. The acceptance record in this proof is synthetic, with actual controller behavior covered separately. Both processes used empty solver stores, governor1 and newer phase candidates disabled; this is a bounded reference reproduction, not complete production restart replay.

The subsequent [bounded writer recovery](./horse-private-journal-retry-2026-09-14.md) now retries a lost acknowledgement or transient lock with exact record identities and confirmed writer termination. It does not make the publisher's pending memory queue crash durable.

Still required: durable complete-population acquisition and missing-decision reconciliation; export/retention ownership before the bounded spool fills and publisher-process crash recovery; fallback/discard capture and lineage; full internal distributions and historical runtime packs/effective work/clocks; cross-host daily-review consumption; causal learning and protected holdout/activation/rollback; native mount/runtime/load qualification; publication and natural evidence. The committed-over10BB reviews remain GTO-unverified. All fifteen phases remain open until their separate first-round requirements are met.
