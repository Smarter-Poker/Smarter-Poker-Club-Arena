# Private known-source completeness inspector

Dormant candidate; not a migration, activation, payment owner, or period finalizer.
Verification: 30 focused native groups passed, with exact check labels and all
executed-source hashes reconciled. Independent source and saved-evidence reviews
passed within this bounded scope. Archive ref:
`backup/resume-poker-sep11/accounting-completeness`.

## Contract

`ca_accounting_readiness_private.inspect_known_sources(uuid, timestamptz,
timestamptz, date, jsonb, text, uuid[])` returns a read-only report for one original
Union, an existing closed Pacific bank interval `[from, to)`, and an existing UTC
Monday earning cutoff. The manifest contains exact full captured source and fact
rows, and its supplied SHA256 is computed from PostgreSQL canonical JSONB text.
The caller must already hold every sorted original/current club lock required by
`fn_ca_assert_union_captured_locks`. Browser and service roles cannot invoke the
private schema or function. The function is an invoker, not a new authority.

Expected rows are derived from original accepted hand authority and captured
contributors/hierarchy, including zero-credit contributors. Missing bank,
contributor, funding-lot, recipient-accrual, club-admission, agent-admission and
player-admission rows are explicit gaps. Existing assertions validate present
rows and all money receipts in encountered pools. A reverse bank lookup detects
an observed captured source omitted from the supplied manifest. Original Union,
booked club, source/fact hashes and caller lock ownership must match exactly.

The report preserves original exact fractions and shows existing slice
attribution separately for clubs, agents and players. Those stages are not
independent new cash: direct-agent capacity funds player payments. Report totals
must not be added into another spendable balance. A future earning week does not
become payable just because its bank week has closed. Later valid admissions can
satisfy an older source without being falsely rejected by a retrospective report.
Original Union self-retained contributors receive no invented club lot; invalid
or overpromised captured terms remain explicit. Eligibility uses the actual
source owner's exact monetary comparison, including a zero-credit entitlement.

`known_rows_complete` means only that the expected rows for this observed scope
are present. `common_finality` and `period_closed` are always false. This function
performs no money, admission, status, invoice or capability writes and supplies no
producer, legacy, global bank-period or final-deal authority.

## Focused verification

The runner archives fixed actual-owner inputs and reuses only the reviewed
private PostgreSQL17 cluster setup. It substitutes the new probe selector and
does not rerun unchanged seal/helper/outer suites. All libpq connection state is
cleared; a fresh Unix socket with no TCP and an empty-database read-only identity
gate precedes schema writes. Synthetic identities, contracts and calendar stamps
are fixture preparation. Accepted-hand, bank, contributor, funding and payment
bodies are the real pinned owners. `owner-setup.py` records the exact archived
composition prefix; `native-proof.json` records the executed source and copied/generated input hashes.
Mutable output logs are kept as evidence, separate from the preserved input
inventory. All preserved input hashes were rechecked after the run. The inventory
contains 30 source and 24 payer files matching their immutable commits. Of the 23
outer entries, 21 match the immutable outer commit, `run-inspector.sh` is the
explicitly derived runner with only the new probe selector, and
`cluster-identity-outer.json` is this run's generated private cluster receipt. The
76 fixture entries are copied or reconstructed inputs. Derived/runtime artifacts
are identified separately from immutable commit files in `input-verification.json`.

The final composition pins outer `15d61d05315b78b3128d330d84e0c9984367c93e`,
corrected payer `c12f993244b1f6b01dd950a8e8fee2b0de07ffef`, source exclusion
`d5300be77e19d08b887b3b851946c5c244b77ad9`, and original captured payer
`7adbfb02544b68ccc1754c51f11d2f61fa406180`. The database-enforced read-only case and
all public-row before/after comparisons passed. Direct anon, authenticated and
service-role calls failed at the private schema. The extra-allocation test is an
explicit corruption fault in a rolled-back disposable transaction, not an output
attributed to the actual contributor owner.

`native.log` is the successful final `native-attempt-03.log`. Attempt 01 passed the
behavior checks but failed while serializing evidence because an inherited probe
variable shadowed an input path. Extraction was narrowed to the exact owner-install
boundary. Attempt 02 passed; the final retry then excluded mutable output logs
from the immutable input inventory. All attempt logs are preserved. Inspector SQL
was unchanged across those harness corrections. The final execution runs only the
new 30 checks; it does not rerun the archived helper or outer suites.

The earlier 30-group private prefix-seal evidence remains unchanged in
`../2026-09-11-cash-period-seal` at archive
`470ea1a65a9f351e811c9dc48c1c3a4dd062c632`. It is separate evidence and is not a
complete-period proof.

## Remaining accounting closure dependencies

| Dependency | Concrete implementation or authority still required | Existing code boundary |
| --- | --- | --- |
| Complete producer coverage | Durable complete original-Union producer coverage and canonical cash/noncash/zero classification. A finite supplied generation-1 set cannot prove no omitted producer or historical source. | `../2026-09-11-cash-period-seal/01-private-prefix-seals.sql`: `seal_producer`; captured `ca_cash_commission_sources` and `ca_cash_commission_facts`. |
| Closed bank interval | A composed producer/bank drain and reverse receipt/journal coverage for the actual half-open bank interval. Inclusive accepted-time prefixes cannot establish bank-time coverage; an old transaction can have an earlier original ledger timestamp. | Prefix `seal_bank`/`admit_bank`; actual `fn_ca_assert_cash_bank_receipt`; this inspector's reverse lookup is observed coverage only. |
| Expected rights and admission rows | This candidate closes the missing-row inspection gap for exact known captured facts, hierarchy and original funding scope. It does not create missing rows or authorize a payer. | `01-known-source-inspector.sql`; original capacity-owner `02-source-admission.sql` and `03-capacity-assertions.sql`; actual club/agent/player admissions. |
| All earned cash and residual rights | Preserve cumulative per-pool/recipient cents, compatible carry and raw fractions. Existing receipts and attribution do not independently certify every global underpayment or assign residual cash. | Actual `fn_release_captured_club_funding`, `fn_pay_captured_agent_funding`, `fn_pay_captured_player_funding` and their slice/assertion tables. |
| Historical liability closure | Close and prove actual legacy R1/R2/R3 writers/claims with their shared basis while preserving historical payable rows and established aggregate shortfall behavior. No late-source cutoff or new legacy eligibility policy is invented here. | Source exclusion `02-excluded-owners.sql`; completion `01-shared-basis.sql`, `02-legacy-round1.sql`, `03-legacy-claim.sql`, `04-legacy-round3.sql`. |
| Authorized period finalizer | A real composed producer/bank/legacy/funding witness must reach the existing finalizer before period or invoice state can change. Caller compatibility must follow existing engine/owner contracts. | Outer `01-source-dispatch.sql`, `02-outer-cascade.sql` and `fn_union_mark_period_settled`; the common-finality gate remains held. |
| Coordinated runtime activation | Reviewed owner hashes, ACLs, admission fences and money contracts must be activated together by the existing authorized release process. Private archive publication is not live accounting activation. | Dormant source, payer, outer and seal archives; engine/Stage-B and final-deal co-owner boundaries are unchanged. |

No blocked legacy-race diagnostic is retried by this work. None of these rows
asserts permission to invent an actor, liability policy, cutoff, residual
allocation, or financial adjustment.
