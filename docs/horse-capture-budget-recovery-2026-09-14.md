# Bounded observation capture recovery

A source request above the reader's hand, action or byte budget previously
became a permanent gap. The same durable request now narrows its attempted
time slice until it can be acquired, then advances sequentially through the
original actor/window. Recovery never creates another request or bypasses the
256 unfinished-request limit.

The original key and endpoints remain immutable. A claim returns both the
original scope and the next persisted slice. A source budget refusal halves
that slice without advancing its cursor; a successful slice doubles the next
attempt's width, capped at the original endpoint. The one-millisecond minimum
and 2,048 accepted-slice ceiling retain explicit gaps. Source expiry is checked
against the remaining cursor, so an already acquired prefix cannot incorrectly
expire a still-readable tail. Missing source authority remains uncertainty.

Journal admission, immutable slice receipt and cursor advancement commit in
one transaction. A lost reply can replay its exact acknowledgment even after
a newer lease has been claimed, without disturbing that lease. Altered payloads
and reused receipt tokens are refused. Journal capacity refusal, receipt-write
failure and transport uncertainty cannot advance the cursor. The original
pre-upgrade admitted receipts remain replayable.

Each request retains one queue slot. The new private receipt table contains
only acquisition metadata and references its own learner request table.
Application roles and the service role have no direct access. Existing service
RPCs retain fixed search paths and explicit execution grants; no financial
source trigger, foreign key or write is added. Retention locks at most 100
terminal requests and removes at most 1,000 slice receipts per call. It skips
locked requests and preserves every receipt belonging to an unresolved gap.

The compiled adapter validates original and slice endpoints independently,
including the exact midpoint/next-cursor acknowledgment. Its old-schema path
still accepts an ordinary unsliced claim. The isolated worker reports slice
progress separately from finished requests and journal completions, resumes
from the durable cursor after termination, and keeps the existing RPC,
watchdog, heap and restart budgets. Source reads remain off the decision clock.

Local verification passed 66 focused tests and TypeScript compilation. The
full server suite passed 11,860 tests across 800 files in 77.75 seconds
(145 existing skipped tests and one skipped file); the ledger declaration
received a subsequent focused check.
The native PostgreSQL 17 proof passed 51 groups and confirmed database and child
cleanup. It reproduced the former terminal-gap behavior before the forward
migration, then recovered an actual 513th-hand overflow through the compiled
adapter with all 12 controller observations. It also proved exact lost-reply
replay across leases, a saturated 256-request queue, journal capacity contention,
transaction rollback on a receipt-write failure, cursor-based expiry, the slice
ceiling and an indivisible burst retaining 22 accepted slices. Retention removed
2,048 old receipts in bounded passes while preserving those partial-gap receipts.
The real worker was terminated between slices; its successor completed the
remaining acquisition and journal writes, then stopped without another RPC.
All fixture hands and metadata were local; no production observation backfill
or gameplay write was performed.

The first native run exposed an integer inference error in the fixture's
generated millisecond timestamp; the fixture now declares that parameter as
bigint. The failed run remains in task evidence.

The terminal `captured` state means all requested slices reached the durable
journal queue. It proves neither journal completion nor a complete natural
observation window. Source cutover/commit-watermark authority, automatic request
discovery, traffic qualification, model consumption, counterfactual evaluation,
shadow validation and activation/rollback remain separate unfinished work.
Local HTTP proves the unchanged client path, not production PostgREST or fleet
qualification. Merge, production schema and served engine evidence are recorded
separately; this component does not complete Phase 14.
