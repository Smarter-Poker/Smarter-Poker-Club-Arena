# Prospective Cash Commission Source Authority

This is a verified local proposal, not an applied migration. There has been no
production DDL, historical accrual, backpay, wallet repair, push or deployment by
this lane. Bank funding and the complete Union cascade remain release gates.

## Source Capture

The accepted hand's exact seat generations, booking clubs, complete agent
hierarchy, player rebate terms, game Union/private stamp and Union club funding
rates are read in one SQL statement for the whole hand. Later inserts use only
that statement's snapshot. Missing or inactive assigned agents remain explicit
invalid assignments. Missing seats never borrow a current occupant.

The source stores the accepted envelope hash and original
`hand_atomic_commits.committed_at` as both `accepted_at` and `settled_at`.
The installed receipt column defaults to `clock_timestamp()`. It is not the
transaction-start timestamp. Capture time is diagnostic, not earning identity.

Player rebate entitlement remains exact, unrounded
`rake_credit * player_rebate_rate`. Cash commission receipt allocations now
also preserve `exact_cumulative_entitlement`, `exact_entitlement` and
`downline_contract_rate`. Their old rounded `amount` is marked
`compatibility_projection_only`; it cannot fund the prospective settlement
path because rounding every hand loses or exaggerates fractional liabilities.

## Receipt Boundary

`03-receipt-source-boundary.sql` is the reviewed local successor to the older
owner-body patch proposal. It keeps the accepted owner's body and signature.

It adds `hand_atomic_commits.commission_capture_version` without a default,
then sets default 1 in the activation transaction. Historical rows keep NULL.
The marker cannot be changed after insertion. An owner-only trigger captures
the first complete cash envelope from its exact durable stack request.
Generation 1, matching `post_commit_payload_hash` and source facts define
admission. An activation timestamp alone is not the source identity.

Actual PostgreSQL races prove that a writer already touching the receipt blocks
the bounded activation DDL, which times out and rolls back completely. An old
owner already running but waiting before receipt insertion sees the new trigger
after activation. Historical NULL and non-NULL envelopes never acquire source
facts. Direct service writes cannot promote an old marker, forge a first
captured envelope or rewrite a captured envelope.

The older `03-accepted-owner-patch.sql` remains historical proposal evidence
and supports the smaller helper fixture. It is not the selected rolling
activation mechanism.

## Funding Snapshot Interface

Sources add `funding_union_id`, `funding_route`, `bank_leg_key` and
`funding_context`. The route is `union_rake_wallet` or
`club_chip_treasury`; bank leg key equals the accepted hand ID. Context keeps
the actual table/private/Union stamp and host-club Union fallback.

Facts add `funding_union_id`, `funding_club_rate`, `funding_state` and
`funding_terms`. Cash rates preserve the installed precedence:
`union_clubs.rate_cash`, then `club_commission_rate`, then .90 only when the
Union membership exists. Missing membership and invalid rates are explicit.
Private or standalone host-club funding and the Union's own retained club are
separate states. A private foreign booking is unbound, not silently paid.

These are immutable expected funding terms. They do not claim that a wallet
has been credited. The bank owner must still consume them and atomically emit
an immutable receipt after the actual wallet and ledger credit succeeds.

## Verification

- `bash source-authority/run-local.sh`: 49 helper/admission checks, including
  actual commission triggers, observed duplicate-accrual and whole-hand
  snapshot overlap, strict grants, fractional entitlements, funding rate
  precedence, private routing, missing membership and invalid rate evidence.
- `bash source-authority/owner-composition/run-local.sh`: 15 actual-owner
  checks using 118 captured table schemas, 195 function definitions and 132
  installed triggers, plus their captured indexes, checks and foreign keys.
  This runs the real cash stack/lease/history/receipt/outbox owner, proves
  activation overlap and last-fact whole-owner rollback, and replays an exact
  lost-response request after membership terms change.

The owner fixture executes the chip cash path. Defined tournament, Diamond,
BBJ and other conditional branches are not certified by those checks. Existing
browser policies, complete operational flows and unrelated triggers are not
claimed covered merely because their schemas are present.

## Remaining Release Gates

1. Actual rake-bank owner routing and post-credit source receipts, including
   observed overlapping/replayed calls and late receipt failure rollback.
2. Source-linked Union-to-club released cash capacity and its immutable
   consumption by Round 2 and player payments. A bank leg or positive wallet
   balance alone is not that bridge.
3. Compatible provisional fractional carry across earning weeks and terms,
   without premature finality, duplicate allocation or negative clawbacks.
4. Actual full outer Union cascade with late Sunday sources banked Monday,
   Pacific settlement/DST mapping, deactivated captured recipients, rollback,
   concurrent claims and exact lost-response receipts.
5. Tournament fee source authority, reporting, management notification delivery
   and invalid configuration resolution.

The production owner and commission functions still require a fresh source and
ACL review before any forward migration. No existing historical source becomes
eligible through this proposal.
