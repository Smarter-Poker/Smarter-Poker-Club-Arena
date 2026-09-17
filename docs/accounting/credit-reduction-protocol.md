# Credit reduction successor — source only, unqualified

This successor addresses relative credit-line reductions in the existing agent dashboard. It delegates the funding change to `fn_admin_update_agent` and uses the existing settlement invoice, Messenger conversation, notification and push-outbox authorities. It does not move chips or establish a payment, amount due, weekly settlement, or a new credit allocation rule. All application, database, concurrency and provider checks remain UNRUN. Source submission and publication are held by the user.

The prior 36 accounting components and their custody remain immutable. The new fragments under `supabase/accounting/credit-reduction-v1` are not standalone migrations. They require one guarded successor transaction, the complete retained predecessor catalog, exact captured supplemental dependencies and the final approved native plan before execution.

## Accepted intent and recovery

The browser captures the authenticated actor, club, target user and actual agent-row identity, requested fixed-cent reduction, exact reason, previous limit, used credit, prepaid state and monotonic control revision. Editing the form or changing the account/view invalidates its prepared operation immediately. Submission captures the prepared operation before any wait; a submit handler cannot prepare a replacement intent.

The shared generation coordinator retains the cashout protocol's existing namespaces, digest, persisted version and migration semantics. A separate credit adapter adds one unresolved lane per actor, club, target user and reduction action. Target user identity keeps that lane stable if an agent row is deleted and recreated. Full intent still binds the original agent-row identity. An opaque account/club index is written and read back before start admission; browser storage retains hashes and operation/generation identities, not amounts, reasons or account identities in plaintext.

Lookup, reduction and explicit retirement use the original actor/operation identity. An absent lookup is not cancellation: the original network request could still arrive. A reloaded handle has lookup/retirement authority only. Only an exact recorded receipt or immutable retirement receipt permits the lane to settle. A failed or ambiguous response leaves it pending. A previously acknowledged generation followed by an absent lookup is contradictory and cannot dispatch again. Each overlapping accepted start validates and acknowledges its own pointer even when transport is shared.

Retirement takes the same club-agreement and operation locks as application. It returns an already recorded result if the change won the race; otherwise it records an immutable retirement that prevents a delayed apply from taking effect. It does not manufacture the financial intent of an absent request. Own historical lookup and retirement do not require a current agent or assignment row or current administrative membership. New snapshot/apply locks the actual club owner and, for a nonowner, the current administrative membership before waiting on the target row, then rechecks authority after nested effects. A committed deactivation cannot be bypassed by an earlier unlocked check. All four new public operations require READ COMMITTED; higher isolation refuses explicitly because an older transaction snapshot cannot establish terminal absence after an advisory-lock wait.

The local pending index does not establish recovery after all browser storage is erased or from a different device. Authoritative own-operation discovery remains a separate required boundary; clearing local data is never proof that a remote change did not occur.

## Amounts and durable records

The server validates raw numeric inputs before storage can round them. Requests must be finite, positive whole cents within the existing dashboard ceiling of 1,000,000,000. Funding limits preserve the actual `numeric(15,2)` range, and revisions cross transport as decimal strings. The actual reduction is the smaller of the request and previous limit. Existing debt, parent/child credit-cap and prepaid rules remain with the original writer. The writer's actual assignment ID and final row are read back; no latest-assignment search or parallel funding writer is added.

Changing a guarded funding, role, status, parent or scope field increments the managed revision. Returning to an earlier value cannot make an old snapshot current again. A stale snapshot refuses rather than overwriting a later decision. A genuine zero-limit, zero-used, prepaid no-change records its operation with unchanged revision and no assignment, invoice or delivery. An invalid zero-limit/nonprepaid state is refused.

Applied changes preserve immutable operation facts, the actual assignment identity and private document provenance. The same transaction creates a `credit_limit_change` record and delivers it to the original actor and target through the existing invoice path. An exact invoice/message/notification join is required; missing or altered durable effects abort the transaction. The deferred push mirror retains its separate preference, enrollment and delivery rules. An outbox record or database commit does not prove receipt on a device.

The private document includes requested/applied reduction and before/after limits, funding states, revisions, original operation identity and UTC timestamps. It omits debt, arbitrary reasons, wallet balances and metadata. It has generated status, no chip transfer, no due date, no amount due, and no journal or credit-payment source claim. Historical reads depend on frozen operation/document evidence, not a surviving current agent or assignment row. Credit-capacity records are independent of the weekly-only rakeback summaries clubs receive.

Private Messenger page/search reads reconstruct the typed credit payload from that provenance and require the frozen audience's own immediate delivery. World Hub uses exact decimal-string/bigint validation and an explicit credit-record card. Malformed or absent typed proof cannot fall through to an ordinary paid invoice. The card states the limit **after this change**, never a current balance derived from a historical receipt.

## Required qualification

Required checks include the actual nested PostgreSQL loader, captured function/access supplements, all prior accounting fixtures, real authenticated/anonymous/service-role checks, false and malformed receipts, all storage interruption stages, real cross-tab coordination, account/form changes, agent recreation, lost replies, apply/retire races, concurrent absolute changes and exact rollback on suppressed/altered audit, invoice, message, notification and outbox writes. Every fixture is source-authored, not a reported pass.

Native qualification of the reviewed writer lock order, wider membership/absolute-credit authorization, absolute credit setting and issuance, all other transaction documents, authoritative cross-device discovery, historical financial evidence, economic terms and final weekly reconciliation remain separate open requirements. This successor is not full-task or release acceptance.

## Finite completion checklist for this successor

Scope is the dashboard relative credit reduction, its shared operation coordinator, the existing credit writer and directly connected callers, and the private credit record through the existing Messenger path. Earlier sealed accounting work is preserved; this checklist does not restart its review or certify the broader weekly program.

- [x] Define exact request, replay, retirement, amount, revision, privacy and nonpayment invariants in maintained source and contract.
- [x] Independently inspect the client coordinator/caller changes and private document, delivery and reader changes; retain the source findings and corrections.
- [x] Finish and independently review the current-manager authority fence and directly connected lock order; the matching real-session and isolation regression sources are retained, with execution pending.
- [x] Integrate the final guarded component after the original36 without changing their bytes; retain all174 earlier source bindings and add58 new inputs (232 total).
- [ ] Review the actual nested fixture/bootstrap/runner wiring and preserve the exact source revisions and local commit custody.
- [ ] Run the final required database, application and real-session/browser checks through admitted protected execution; demonstrate the identified failure cases and repaired behavior where feasible.
- [ ] Obtain exact compatible deployment identity and verify the affected live behavior when publication is authorized.

No runtime reproduction, application test pass, enforcement, merge, deployment or live success is claimed for this successor. Test source and review findings are not substitutes for those unchecked outcomes. No recurring repair mechanism is added; correctness belongs to the original transaction and explicit recovery action.
