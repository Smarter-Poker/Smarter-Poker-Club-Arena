# Lightning Halt Acknowledgement, Parked-Table Health And The Dark Shadow Worker

Date: 2026-09-25. Branch: `agent/claude-lightning-p5r2/lightning/remediation-engine`. Engine only; no SQL.

## Dealing Halt Remediation

- **Acknowledgement (P0 companion).** A table parked at either halt gate with no hand in progress calls
  `fn_cash_table_observe_dealing_halt(p_table_id)` once per distinct `dealing_halted_at`
  (`observeDealingHalt`), again when the value changes, and forgets it when the column clears.
  Failures, including PGRST202 before the migration is live, are logged at most once a minute and
  retried on the next parked pass. The table never deals because of a failed acknowledgement.
- **Faster halt reads.** A cash table with a `cluster_id` re-reads `dealing_halted_at` and
  `dealing_halted_reason` alone every `DEALING_HALT_TTL_MS` (5 s): with the roster inside the
  prepared-hand inputs (honoured after the rest, with no second read there) and on every parked or quiet pass.
  Every other table keeps only the 60 s rule re-read. The interval is argued beside the constant.
- **Parked passes are healthy passes.** Both halt branches run `passWhileDealingHalted`, which reaches
  `stopIfClusterTableClosed`; the dealing branch resets `consecutiveErrors`; `releasePauseGate` uses
  `isNextHandPaused()`.
- **Leaving behind a Lightning hand.** `LIGHTNING_HAND_IN_PROGRESS` from the database is "not now":
  `leaveTable` writes the durable `leave_pending` request and answers `success: true, immediate: false,
code: 'LIGHTNING_HAND_IN_PROGRESS'`; the dealing loop re-arms its sweep every halted pass while the
  roster shows a leaver, and the quiet loop runs `sweepQueuedLeaves`. Add-ons, Diamond top-ups and the
  pending add-on resolvers treat the same refusal as a retry, never an engine kill.

## Dark Shadow Worker (`server/src/lightning/`)

`LightningConfig`, `LightningRpc`, `LightningPresence`, `LightningClusterWorker`, `LightningSupervisor`
and `LightningMetrics`. The supervisor runs on the leader beside the ClusterController and starts a
worker only for a Cluster with `cluster_mode = 'lightning'`, `lightning_enabled`, and
`fn_lightning_config` `worker_mode <> 'off'`. None qualifies today. Shadow workers make one read-only
`fn_lightning_match` call per pass; `form` mode is refused until a dealing host exists.

## Tests

- `server/src/engine/AHaltedTableFinishesItsHandAndDealsNoOther.law.test.ts` (extended)
- `server/src/engine/DealingHaltAcknowledgement.test.ts` (real dealing loop and start())
- `server/src/engine/LightningHandInProgressIsNotNow.test.ts`
- `server/src/lightning/LightningShadowWorker.test.ts`

## Verifier Fixes (2026-09-26)

- Halt reads are numbered before they are sent; stale answers and reads sent before the
  acknowledgement cannot release an acknowledged halt.
- The 5 s halt poll runs only while halted or when the Cluster has `lightning_enabled`; otherwise 60 s.
- Only Lightning-deferred leaves are retried every pass; stay-clock holds keep their own release.
