# Recover the original capture evidence

Accepted source witnesses were durable but inaccessible to the engine after a
restart: the acquisition tables correctly deny direct application reads. A
service-only reader now retrieves an actor's exact request and at most 64
accepted slice receipts in one stable database statement. It uses the existing
request/slice index, a 65th-row lookahead, a 1 MiB response ceiling and the
existing five-second client call budget. It never reads source hand history,
enumerates other requests or changes a queue, receipt, model or policy.

Each returned slice carries its original canonical witness, digest, interval,
batch identity and observation count. The reader independently compares its
journal receipt and reports its queue state. A missing journal, retired payload
or absent historical witness remains explicit. A digest or scope conflict is
unavailable, rather than a matching or empty result. A matching journal receipt
does not certify retention of every observation.

Pagination binds the original actor/window and a revision of the request's
state, captured cursor, segment/count totals and terminal timestamp. Later pages
require that same revision and the actual prior receipt cursor. The compiled
adapter checks contiguous intervals, segment ordinals and cumulative counts.
Committed request changes, lost cursors and interior or final gaps refuse the
traversal. A request can be queued, leased or in a retained gap while its already
accepted evidence is reviewed; finishing a page does not complete that request.
Each page has its own read timestamp: journal state may change between pages.

The adapter validates and freezes input scope before awaiting I/O, accepts only
the recorded canonical witness bytes and freezes returned records. Historical
source read times are preserved even if the wall clock later moves backward.
Legacy receipts without witnesses remain null; older requests without per-slice
receipts are explicitly unsupported. No private cards or action payloads enter
this response. The reader always reports source coverage as not established.

Verification passed server compilation, 113 focused tests across four files and
11,926 server tests across 802 files in 67.72 seconds. The existing 145 skipped
tests and one skipped file remain declared. The PostgreSQL 17 proof passed all
63 groups, retaining prior acquisition, restart, queue, privacy and retention
checks. New checks recover two witnesses recorded by the actual compiled worker
across its termination, remove original source rows and recover byte-identical
witnesses inside a read-only transaction with unchanged persisted metadata.
Another 65 snapshots go through real source/admission/finish functions and
traverse pages of 64 and one. Their fixture partition is explicitly set to one
millisecond to exercise pagination; it is not a traffic-capacity benchmark.

The native proof also checks cross-connection revision changes, missing cursor,
interior and final receipt loss, retired/missing/conflicting journals, legacy
representations, invalid cursor pairs and service-only access. All local
database and worker processes were stopped and the fixture directory removed.
The first run correctly rejected an incomplete legacy test fixture: converting
a captured root to the historical admitted shape also requires its recorded
batch identity and count. That fixture was corrected and the failure retained.

Source publication, schema installation, served engine identity and natural
execution are separate acceptance facts recorded in the task evidence. No
production fixture hands or learning writes were made. Automatic discovery,
complete-window authority, model consumption, causal proposals and the guarded
shadow/activation/rollback pipeline remain Phase 14 requirements.
