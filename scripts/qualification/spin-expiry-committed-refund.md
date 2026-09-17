# FIFO5 R2 — committed cancellation competing with expiry

The final hosted adaptation remains unqualified until its exact required CI
execution passes. It consumes the same genuine funded/aged disposable fixture as
R1/R5, now supplied by `test-spin-expiry-postgres.py` in the existing hosted
`accounting_postgres` job. The race runner itself does not provision that fixture.
Maintained donor266ae2218d02a9f966a9753e94415bbf1cadd026 retains the financial
assertions; the hosted R1/R2 changes are connection handling and declared hashes.
The earlier R1/R5 source custody at1ac859e06267890fd4900655cfe1c06a5bf4bea0 is
historical provenance, not the current transport pin or proof of execution.
See `spin-expiry-lock-order.md` for the versioned v6 fixture provenance and finite
release scope. No retired local runner, VM or admission service is required.

## Scope and actual authorities

Support is intentionally limited to one ordinary-chip, three-seat Spin with two
distinct fresh paid players, two live seats and exactly two wallet_charge refund
entitlements. Gross and prize rails equal the positive buy-in; fee/bounty are0.
Each entitlement has NULL registration_id, as required by the actual wallet-kind
contract, and an exact original user/club/source-debit journal. The cancellation
line instead uses that user's locked current roster ID. No prior refund, credit
claim, obligation, tranche, ticket, draw, reserve booking/unwind, fee/rake, launch
or hand is supported. No original/historical production ID is a fixture input.

The actual pinned `fn_poker_diamond_tournament(uuid)` must return false. Ordinary
wallet shape or a club name does not decide that branch. No classifier/policy
mutation or caller-supplied admission flag can force it false.

The existing creator and authenticated take-seat paths must produce the fixture,
with independently retained capital, live-session, purchase and natural-age
receipts under the authentic versioned fixture and hosted wrapper. The author has not copied old
opening-balance seeds, inserted fake journals, changed clocks or created a new
standalone payment authority. The runner calls only the real public cancellation,
expiry, existing global helper, canonical receipt reader and read-only classifier.
It never calls the private exact refund payer directly.

New `spin-expiry-committed-refund.authority.json` carries selected exact public
catalog SELECTs and their retained expected rows. These derive from parent read-only
captures1406/1408/1409/1410/1412/1420/1434, each with its original file hash.
Timestamp observations are omitted from comparisons;
every retained definition, ACL, configuration, RLS/policy, column, constraint,
binding and65index observations are otherwise compared. Existing NOT VALID checks
remain accurately NOT VALID; the fixture does not alter or silently validate them.
These selected dependencies are not a complete transitive financial provider.

Full-definition MD5 pins include cancellation6dac23baee41ff69ee0e1243f0a26c8e
(in unchanged B), receiptcf0bf7f56e2e50376626c37b59cfaca8,
plan5c60c0ab184aaf8dd8a83bae98e513f1, exact payer5e696c31a3f1af7a95f34fd91d6915d4,
wallet trigger8a0be491c87f37224f9dee7cfd274085,
exact escrow2d76b04e7ed4feda16b6e9420d7c00cd,
general escrowc6c26c25ab8a8b1222d375c7d6df0d2f,
ledger declaration1991d9f52317f33a4b9cf560d6fc91d5 and
Diamond classifierc91028508fecc2d02e9003f2bdc2e38d,
actual chip-balance writer1f8bc3e17233defa23ebfda4e30015db,
ledger enricher5931f47d922eea26ab1ea2b12f3f7c8c and
separate promo-balance autoledger2ff8923b4c2d8fd3d343cf37acce0f2c.

## Real separate-session schedule

The runner requires explicit protected psql path, execution UUID, new genuine
fixture tournament UUID and new retained journal path. The only database target is
`qual_spin_expiry_<execution without hyphens>`, PostgreSQL17/logical port5432
through the allocation's owned mode0700 Unix socket, with TCP listeners disabled.
It connects as nonsuperuser postgres; actual expiry/cancellation transactions use
service_role with matching role claims and NULL auth.uid(), while observer and
lock-control transactions retain empty claims. It inherits no project/production
credentials or libpq environment. Environment, exact B candidate, selected R2
authorities and actual positive fixture state must all match before transaction
work. Tripwires alone do not establish continuing exclusivity or network isolation.

1. B acquires the existing global settlement G→B locks and retains its transaction.
   A calls actual `fn_spin_expire_unfilled(1)`. The observer must see A waiting on
   an advisory lock blocked by B. With the exact frozen candidate, this binds an
   earlier actual candidate scan and its first global acquisition.
2. B calls canonical `atomic_cancel_tournament(fixture,NULL)`, retains the returned
   provisional receipt and forces all deferred constraints. Before sending COMMIT,
   the journal durably records exact operation, allocation, tournament, backend and
   actual transaction identity. No receipt before COMMIT is called committed.
3. Following B's acknowledged COMMIT, an independent observer statement reads the
   actual persisted state and canonical receipt. The positive oracle below must
   prove the two actual refunds and complete selected terminal state.
4. A resumes its current post-lock read. It must return exactly `ok:true`, expired0,
   failed0, skipped_raced1 and an empty tournament_ids array. A then commits its
   own transaction with separate durable intent. Selected state must equal the
   committed B observation: no second refund or hidden committed change.
5. A new replay session calls canonical atomic_cancel again, forces deferred
   constraints and commits. The original stored JSON must return byte-value-equivalent
   canonical JSON (no replay flag is promised). A fresh reader and every selected
   row/identity/amount must equal B's committed result.

This tests committed **canonical cancellation** against an already-scanned expiry.
It does not claim that expiry itself committed the refund; R1 separately exercises
actual expiry cancellation inside rollback. It is not the final-paid-seat/draw race.

## Positive financial and lifecycle oracle

All database numeric tokens use the unchanged Decimal parser, never binary floats.
Evidence encodes exact decimals with `$decimal` string tags; raw transcripts retain
the original wire text. The oracle accepts finite exact-cent numeric values only.
There is no use of chips_refunded_estimate as a financial receipt.

- Before cancellation, two original immutable entitlement/source-journal/reporting
  debit amounts agree. Their exact clubs and users bind actual paid wallet balances.
  Prize escrow and gross_in equal their sum; all other original in/out/refund/reserve
  rails are0. Original creator/capital/authenticated payment admission remains
  independently required: a matching observation alone cannot manufacture it.
- After commit, exactly two new and bijectively distinct tranches, obligations,
  credit registry keys, refund journals and reporting wallet credits exist. No
  earlier immutable row changes. Each line uses
  `tourney:<event>:refund-entitlement:<entitlement>`, the actual source club, gross
  paid now, before0, prize=gross and bounty/fee0. Wallet-kind registration remains
  NULL on the source, while its line identifies the exact retained roster row.
- Each actual original-club balance increases by exactly its entitlement. Other
  wallets remain unchanged. A registry row has non-null matching user and amount;
  nullable schema alone is not sufficient. Line/tranche/report/journal/obligation
  IDs, source, components and canonical cancellation description must agree.
  Every obligation is fully paid, and no one-use authorization remains. The runner
  reads only the authorization count, never its capability token values.
- The actual `fn_club_members_ledger_writer` produces the refund journal through
  the enabled chip-balance trigger. It omits the four pre/post balance columns;
  their NULL defaults remain NULL, while status defaults to posted. The oracle
  requires that shape. The separate promo-balance autoledger does not establish
  this refund's balance metadata. The positive before/after wallet observation and
  reporting balance_after prove the selected delta. The journal's auto-audited
  description is distinct from the canonical tranche/report description; neither
  is substituted for actual financial identity or movement.
- Escrow refund_prize rises by exactly the sum, every remaining bank becomes0 and
  no other source/out/reserve rail changes. Header totals and exact original player,
  table and seat UUID sets match; no zero/ticket/refund disposition is omitted.
  Actor/settled_at are original stored facts, not new replay identities.
- Parent, roster, table and seats retain exact identity/user/table bindings and
  reach the canonical closed states at the stored timestamp. Parent break and seat
  leave/sitout/away state clears. Only explicit target update fields may change;
  unrelated rows and whole relation identity sets remain unchanged.
- The unchanged19-relation snapshot is extended with registry/rake rows and a
  count-only capability observation. Replay compares this entire selected state.
  Unlisted tables, ledger chain semantics and sequence allocation still need the
  protected owner's complete provider/integrity and whole-allocation evidence.

Eleven negative-oracle controls mutate copies of an actual accepted post-commit
observation: duplicated line, NULL registry amount, missing tranche, one-cent
wallet mismatch, escrow refund-counter mismatch, missing original roster, changed
original debit, leftover capability, uncleared seat, unposted refund journal and
invented balance metadata. These never write the
database. A proper oracle refusal is required; unrelated exceptions cannot count
as the expected rejection. All controls remain UNRUN with the scenario.

## Commit uncertainty, bounds and disposal

R2 intentionally persists money/receipt rows **inside the disposable allocation**.
An outer ROLLBACK cannot undo B's COMMIT, A's COMMIT or the replay transaction.
No fixture deletion, compensating payment, manual receipt insertion or production
repair is used to make a before/after snapshot look restored.

The new exclusive JSONL journal fsyncs records and its new directory entry before
commit dispatch. The protected owner must bind/retain that inode and qualify the
actual storage durability; a successful write is not storage qualification. Once
COMMIT is sent, its intent is `may_have_committed` until acknowledged and separately
observed. Lost acknowledgement, reader failure, process death or missing cleanup
retains that original uncertainty. No automatic replay, payment or compensation
is attempted. A later trusted serialized read can adjudicate the original; client
exit or backend absence alone cannot distinguish commit from rollback.

The runner's original deadline is20seconds with a separate5second cleanup attempt.
Each scenario asks for8second statement/4second lock/12second idle-transaction limits.
The actual cancellation function has its own120second statement_timeout; its reader
has a30second function configuration. Requested session limits do not establish
nested operation bounds. The protected owner must qualify actual PG17 semantics
and enforce the original whole-allocation deadline. The R2 schedule requires B's
normal cancellation/commit to finish before A's actual4second global lock timeout;
an insufficient provider fails, without silently extending these limits.

Selected state is limited to1000rows per relation and512KiB serialized output;
each inherited session output is capped at8MiB and the retained journal at32MiB.
These are output bounds, not a PostgreSQL allocation guarantee. Narrow real fixture
size and observed cleanup remain required. The hosted wrapper enforces its original
240-second work and30-second cleanup bounds, retaining forced cleanup as failure;
it does not claim a retired cgroup/namespace or local-provider containment layer.

All original clients must have an observed terminal exit, and a fresh server
observation must show no other backend or original locks. These are independent
requirements; neither overrides a failure of the other. The final observer's own
exit and actual **whole-allocation disposal** still need independent protected
receipts. The runner never sets allocation_disposed or full_qualification true.
A successful process exit means only the implemented observations completed; the
required-check collector must refuse acceptance without the bound disposal receipt.

The historical broader native failure-injection requirements include deferred
failure, COMMIT acknowledgement loss, readback loss, journal I/O failure, timeout
during canonical refund, original-client exit failure, lingering backend and
source-read failure. Retain exact mutation identities and full evidence for any
such qualification. These controls remain unverified; ordinary positive source
coverage is not their execution evidence. The current finite release scope in
`spin-expiry-lock-order.md` uses the existing hosted job, and neither a source
control nor a narrow positive result may claim these broader cases passed.
