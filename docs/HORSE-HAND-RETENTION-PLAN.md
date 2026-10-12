# Eight-day settled horse-hand retention repair

Owner direction 2026-10-12: delete settled horse-only hand contents after eight days; preserve every hand containing a human forever. This task does not change balances, earnings, payouts, or existing unresolved settlement protections.

## Current verified state

The original production policy was eight days, but cleanup retained full submission requests and other duplicate hand contents. About118GB of requests accumulated; a bounded sample found42% already disposed, which does not establish safe reclaimable bytes. Five qualified corrections are now installed: original request compaction, bounded batches, original human classification, compact settlement replay certificates, and cash hand-content compaction. Exact installed versions and live evidence are in the owning checkpoint.

The two affected existing cleanup jobs are temporarily paused while connected safeguards preserve accepted derived statistics and lifetime hand counts. Old fact deletion demonstrably subtracted earned summaries and could delete facts from mixed human hands. Replacement removes only qualified horse hole cards, retains every derived fact and summary, and captures compact original accepted statistics before deleting their raw copies. Adaptive raw data becomes exact sufficient statistics only after its versioned engine consumer is deployed and verified. Historical completion gaps remain protected; the entire rule and physical reclamation are not yet complete.

## Acceptance contract

- Eight full days must have elapsed from both the original hand and successful completion of settlement obligations. A hand settled yesterday remains protected even if dealt earlier.
- A mixed human/horse hand is human history and stays forever. Missing profiles, invalid player IDs, uncertain classification and inconsistent receipts stay protected.
- A hand is not eligible merely because it is old: native settlement/postcommit, accounting/rakeback, bounty/escrow, disputes/reports, F06 permits and movement boundaries must be resolved.
- No balances, earning source totals, settlement identities or replay fences are deleted or rewritten. Compact hashes/identities may outlive erased hand contents to prove disposal and prevent reapplication.
- Each cleanup transition is idempotent, authorized, bounded and concurrency-safe. It belongs to the existing retention authority, not a new repair watcher.
- Human and unresolved payloads remain byte-identical; historical replays cannot settle or pay twice after erasure.
- Source, isolated qualification, installed migration hash/ACL/search_path, executed retention readback, backlog count and reclaimed physical bytes are separate evidence.

## Delivery sequence

1. **Inventory and eligibility:** map all per-hand relations and consumers, classify payload vs. monetary evidence, record actual installed definitions. Measure old eligible payload and protected backlog with indexed/bounded reads.
2. **Original request payload:** retain immutable identity/request hash/disposal receipt; erase only the bulky request of an already-retention-disposed, proven horse-only hand. Narrow trigger exception permits no other mutation. Extend the existing disposal/retention path and qualify a bounded backlog pass. Reject replay after erasure.
3. **Related copies:** inspect accepted rosters, cash participant manifests, cash provenance accepted_request/atomic_receipt, snapshots, adaptive journals and settlement results. Erase only payload fields whose consumers have completed; preserve accounting provenance needed to reconstruct unsettled obligations. Integrate qualified per-hand erasure into the same retention transaction. No blanket age DELETE on monetary tables.
4. **Accounting inventory:** establish sealed checkpoint coverage and all as-of consumers before compacting historical before/after payload. Preserve boundary truth, reconciliation and human-hand evidence. This is distinct from deletion of poker-hand contents.
5. **Daily Challenge dedupe:** retain the current delayed-event rejection horizon until a compact tombstone retains identical reward replay safety. Horse-only hand content may expire at eight days; never make old events payable again by deleting receipt keys.
6. **Existing backlog:** run finite owned bounded batches through the same qualified transition and retain operation outcomes. Do not create a new recurring repair loop or cursor service. Historical disposal settled=true and F06 accepted status are insufficient proof: a real native counterexample accepts a failed postcommit. Only independent immutable successful completion, exact original identity/hash and horse classification qualify old records. Unknown records remain protected, and their size must be reported separately. A source merge alone is not backlog removal.
7. **Physical reclamation:** determine free pages/index bloat after compaction. Ordinary vacuum makes space reusable; physical shrinking may need supported online rebuild or planned maintenance with measured headroom/lock budgets. Never VACUUM FULL a hot production table without qualification. Supabase provisioned disk resizing is separate from reusable/reclaimed database bytes.
8. **Closure:** required local/hosted checks and protected merge, migration installation once outside :50–:03UTC, readback of function hashes/ACLs/triggers, eight-day cleanup behavior plus fresh human/unresolved/replay tests. Record every completed and outstanding phase in the existing checkpoint. No claim that all disk growth is eliminated; genuine financial records continue to grow.

## Focused regression matrix

Settled old horse; seven-day horse; exact eight-day boundary; mixed human; missing/deleted profile; reported hand; unpaid tournament bounty/open escrow; reserved F06 permit; current movement witness; mismatched receipt/hash; caller lacks permission; arbitrary UPDATE/DELETE/TRUNCATE; concurrent cleanup/replay; repeated cleanup; interruption. Use native PostgreSQL17 with real guard functions and fail-before/pass-after, never financial faults on production.

## Explicit exclusions

No deletion of the solved-spots warehouse, human hand history, financial ledger totals or another agent's source/evidence. No new recurring repair job, disk expansion or schema-probe DDL on production. Database changes compatible with the serving engine deliver independently. Only adaptive raw retirement depends on deploying the specific new versioned consumer through the existing engine route.
