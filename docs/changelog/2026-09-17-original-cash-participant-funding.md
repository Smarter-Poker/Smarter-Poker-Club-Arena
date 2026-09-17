# Original cash participant funding and hand provenance

Scope: Union Accounting + Rake Back. Prospective source capture only. This change does not authorize payments, certify a whole accounting period, infer beneficial ownership, or reconstruct missing historical records.

The original wallet debit trigger now returns its actual ledger identity to the existing buy-in, rebuy and add-on cores. Those same original transactions retain the actual wallet journal, debit account, funding club/union, asset, seat, exact join timestamp and occupancy. The treasury funding core retains its own actual debit ledger. Previously admitted unkeyed calls receive an immutable receipt for the actual transaction without changing their existing purchase semantics. No payer is renamed or added. A guarded successor compares each replaced function's exact installed definition, owner and ACL before preserving that authority in place.

Pending delivery retains the actual original pending-operation ID and occupancy credited by the existing resolver. An unresolved or differently applied pending purchase remains uncertified. No timestamp-proximity join or latest-membership lookup links any debit.

The actual engine controller roster is frozen before controller construction under the exact existing lease. The manifest includes every participant, original stack and seat generation, including horses and players whose eventual contribution or delta is zero. A failed/unknown capture is reported and retains the existing playable but uncertified protocol. A prestart failure consumes the existing global hand number; a new deal uses another number. Stops, pauses and expired lease proof after the new await do not construct a controller.

The original accepted-hand owner retains the complete original JSON hash envelope with its exact normalized submitted roster. The immutable accepted receipt independently verifies that envelope's SHA256 against the original atomic commit hash. The accepted roster must equal the frozen manifest, and signed participant deltas plus rake and BBJ must equal signed external net. Existing canonical stack-writer requests and money arithmetic are unchanged. An invalid claimed manifest rolls back the existing accepted-hand subtransaction, including stacks, history and acceptance receipts. Exact retries retain one receipt. Legacy accepted hands remain enumerated and explicitly uncertified.

All four evidence tables refuse UPDATE, DELETE and TRUNCATE. External roles cannot insert evidence or call private capture primitives; the original engine-facing predeal RPC retains its existing service/lease authority. The lease holder takes FOR KEY SHARE, preserving the existing heartbeat/takeover protocol.

## Consumer contract

- `cash_participant_funding_receipts`: immutable actual debit/journal/account/club/user/occupancy/asset records. Receipt IDs are prospective operation identities, not historical attribution.
- `cash_funding_application_receipts`: exact pending funding delivery or refund and the occupancy actually credited.
- `cash_hand_participant_manifests`: immutable actual predeal roster, original game scope, exact lease and funding references; unique table/hand number.
- `cash_hand_provenance_receipts`: immutable accepted `hand_id`, `payload_hash`, full `accepted_request`, exact manifest reference, participants with `stack_before`, `stack_after`, `poker_delta`, signed external net and truthful completeness flags.

`funding_provenance_complete` means an original admission and a single actual funding account are evidenced, with pending delivery to the same occupancy. It does not establish a commercial beneficial-ownership allocation. Mixed wallet/treasury funding, legacy admissions, moved occupancies without original continuity, unsupported assets, and absent external-bank links remain uncertified. Nonzero external net is conserved but carries `external_bank_receipt_not_certified`. An all-horse hand is included without treating an `is_horse` flag as evidence of treasury funding.

The atomic history ID and stack-settlement ID can differ: the former is `hand_atomic_commits.hand_id`, while existing stack claims use `hand_atomic_commits.stack_result.hand_id`. The canonical stack writer retains its monetary/seat subset; full occupancy/manifest references are retained in `cash_hand_provenance_receipts.accepted_request.stacks`. A consumer must compare both contracts without guessing identity. The P&L reader is owned by the parent delivery and is intentionally not replaced here.

## Validation and limits

The existing native chip-journal verification path runs `scripts/dev/probe-cash-participant-funding.py`. It uses private PostgreSQL 17, the existing controlled policy fixture, and captured current original money cores, accepted-hand owner, stack writer, journal trigger and hand-history writer. The old original buy-in core demonstrably fails the same retained-receipt coverage assertion; the candidate passes. Positive checks cover unkeyed original funding, actual cross-club debit, pending delivery, all-horse zero-rake hands, signed negative external net, exact replay, departed participants and membership changes. Refusal checks cover journal failure, omitted zero-delta participants with whole-transaction rollback, immutable evidence and stale lease/ACL boundaries.

The focused engine suite exercises the real deal method and controller-construction boundary, alongside transport/identity tests. Server TypeScript and source/manifest checks run against the final candidate. PostgreSQL policy/auth helpers are controlled fixtures; full installed production triggers, live permissions, external bank receipts, tournament provenance, historical periods, protected CI, installation, engine publication and live behavior are separate evidence layers. This source contribution has not been pushed or applied to production.
