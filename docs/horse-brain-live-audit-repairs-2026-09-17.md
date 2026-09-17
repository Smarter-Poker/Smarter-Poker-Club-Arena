# Horse Brain: closing the September 17 live audit defects

Scope: three defects observed after the protected Horse release, plus the existing publication and production verification gates. This document does not certify all fifteen strategy phases, activate shadow candidates, or turn historical diagnostics into GTO authority. The larger phase completion plan remains `horse-brain-phases6-15-completion-plan-2026-09-17.md`.

## Observed baseline

The successful protected release `4a2bff6f782b7d6ee5ab191b9c611b97decc9760` was sealed at 07:56:06 UTC. A bounded natural observation found 38 post-accepted-wager plan-commit refusals. Current source reproduced two possible causes with the real worker/client and controller: 128 intervening empty FAST results and age beyond 60 seconds. The combined historical error cannot identify which cause produced each of those 38 refusals.

Three natural retained-hand reviews matched all seven accepted Horse actions and verified all three request lifecycles. Each review remained incomplete with `action_origin_unavailable`. The actual forced-post and uncalled-return producers omitted provenance required by the reader. The aggregate sample did not identify the offending row in each hand.

The original private journal reached 7,888 records and 67,107,868 serialized bytes against its 67,108,864-byte limit. A read-only observation on the containing `afae00d32fd7417464924bb22db0ba48f3bfef92` release retained those counts. Restarting against the same file did not provide new capacity. No original record was deleted or modified to make the audit appear complete.

## Owning repairs and preserved boundaries

### Volatile plan ownership

The worker must reserve an applicable original batch before promising issuance. Pending ownership must not disappear because unrelated FAST traffic fills a cache or a thinking interval exceeds a cache age. The existing total entry bound remains 128; unavailable admission, no applicable effects, refused commit, volatile application and exact duplicate acknowledgement remain distinct outcomes.

The client retires exact unused ownership independently of whether journal capture is enabled. The accepted-wager path transfers ownership to its commit before cancelling completed computation. A generic cancellation is not a plan retirement signal. Effects remain the detached originally issued batch, applied only after the actual controller accepted the intended wager. Rejected/coerced wagers cannot acquire application authority; conflicting or partially failed application cannot become a successful retry.

This repair addresses the observed volatile delivery seam. A volatile acknowledgement does not prove durable plan recovery across process loss. Capacity-unavailable accepted wagers must remain visible; moving a refusal earlier is not full application coverage. The Phase 15 durable acceptance/replay package remains separately qualified.

### Action provenance at the original producer

The existing forced-post event handler stamps `origin: 'forced'`. The uncalled-bet-return handler stamps `historyEvent: 'uncalled_bet_returned'` without claiming a poker-choice origin. The controller has already moved the chips; these changes only annotate the retained history.

The private reader accepts that return marker only with the exact return action, a positive finite amount and absent origin. Missing legacy metadata, an unknown marker, or any contradictory origin remains an explicit gap. All original rows, ordinals, amounts and hand-binding projections remain intact. Posts and returns remain excluded from voluntary-action learning. No historical backfill or financial mutation supplies missing proof.

### Private archive custody and reader continuity

The original 64 MiB SQLite spool is retained. The dedicated journal writer owns new compressed, immutable batch segments and a transactional index. Original records, event IDs and producer/sequence identities survive unchanged. A durable acknowledgement requires the owning batch to have been written, synced, independently read back and indexed. One bounded pending batch retains interrupted work for completion at the next owning open/append operation; no new timer, periodic repair or cleanup process is used.

The archive lives in the `archive` child of the existing private persistent journal mount. Its production allocation is 8 GiB of compressed segments and at most 500,000 segments, independently bounded by the catalog's 2 GiB physical ceiling. The original spool's limit is unchanged. This allocation was selected with 34,375,565,312 bytes of observed host free space; it leaves approximately 24 GiB before catalog growth and other host use. Free space is dynamic and the storage implementation must still fail truthfully on exhaustion. These are resource limits, not a retention-duration guarantee.

Strict positive-integer overrides are `HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES` and `HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS`; segment count cannot exceed 500,000. Invalid configuration refuses writer startup rather than silently disabling the bound. No new public/cloud bucket receives Horse records.

Private hand review, corrective review and accepted-roster review/export use the same archive-aware store. A present but corrupt, incomplete or linked archive cannot silently become a successful legacy-only read. Read-only commands neither create storage nor complete a pending append. They preserve existing selected-hand record/byte limits and report missing or oversized evidence explicitly.

The existing review command also accepts `--storage-status <absolute-private-journal-directory>`. It returns aggregate usage and limits without player, hand, card or path data and without claiming a complete captured population. There is no automatic deletion, arbitrary eviction or concealed quota extension. Additional retention beyond the configured resource allocation requires actual provisioned custody; no finite local allocation supports unbounded history.

## Verification and release record

Red-before cases are retained in the task evidence directory for accepted-wager plan loss (two failures), missing/malformed origin (eleven failures) and incorrect legacy-only archive reads (two failures). Repairs extend the existing worker/controller, provenance, storage, reader and private CLI suites. The final combined source passed 726 tests across seventeen existing suites with Node 22.23.2, and the complete server TypeScript check passed. Existing required GitHub checks still qualify the submitted revision; these local results do not substitute for protected checks or publication.

Use the existing protected GitHub checks and Club Arena publisher/engine-release workflows. Verify installed image/component identity separately from client publication. After release, observe naturally accepted decisions, exact plan dispositions, continuing archive commits and private readback. Preserve uncovered natural cases and any capture gap across the earlier full journal; do not inject production hands or infer missing historical records.

The original broad certificate `35197102196` failed, and the later `35207909697` still had three live-table failures after login and the UI sweep passed. Full Club Arena Audit owns the remaining cash-dialog problem; MTT owns tournament/table-readiness work. Their repairs and final production certificate remain separate from these Horse source fixes. No broad certification is claimed until the existing required after-verification actually passes on the applicable deployed version.
