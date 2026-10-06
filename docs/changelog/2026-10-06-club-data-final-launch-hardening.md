# Club Data Final Launch Hardening

## Scope

This phase closes the launch blockers found in the authenticated Club Data,
Player Stats, Financial Admin, Financial Incidents, Drift Gate, Credit Admin,
Settlement, transaction ledger, and directly linked reporting surfaces. It is
a Club Arena client and database delivery. It does not replace or restart the
game engine.

## Root Repairs

- Club Data player readers now follow the physical union table scope while
  preserving home-club attribution, permissions, horse privacy, immutable
  export ownership, and export retention/concurrency guards. Standalone clubs
  remain scoped to themselves.
- Virtualized game and player lists keep their measured scroll space instead
  of allowing flexbox to collapse the spacers. Loaded-row copy now describes
  fetched rows rather than implying that every row is mounted at once.
- Club Data accepts a live or cached ledger only when the returned reporting
  window exactly matches the dates on screen. Snapshot and cursor-page
  responses now carry a versioned receipt for the exact club, date range,
  filters, search, sort, cursor, and limit. Initial loads, recent-page
  prefetches, pagination, cache reuse, and empty pages all fail closed when any
  request dimension differs.
- Drift incident and gate readers validate the complete RPC boundary and fail
  closed on malformed booleans, counts, timestamps, unordered series, stale or
  future decisions, contradictory incident state, and unverifiable balance
  data. A failed refresh keeps the last verified view and is never rewritten
  as a clear zero-state.
- The incident schema repair corrects the one measured historical timestamp
  inversion and enforces coherent incident status/timestamps at the database
  boundary.
- Player Stats preserves unknown measurements as unknown, requires meaningful
  samples before qualitative position claims, validates exact cash, session,
  position, tournament, recent-tournament, quality, and request-scope
  contracts, humanizes dynamic copy, uses honest ordinal suffixes, compacts
  chip values, and keeps rates at one decimal. Headline totals remain complete;
  only the analysis collections use their declared cap, which is disclosed in
  the interface. Zero-hand rate fields render as not yet measured rather than
  invented zeroes.
- The all-clubs owner Stats projection now carries the same mystery-bounty
  flag, knockout count, complete buy-in, bounty winnings, and prize-plus-bounty
  total as an exact-club response. A mystery-bounty cash can no longer be
  normalized into a false ordinary-tournament loss.
- Owner notable hands now use the same versioned request-scope envelope in the
  All Clubs and exact-club views. The client verifies target account, club,
  asset, visibility, timestamps, identities, cards, counts, and exact monetary
  fields before it renders a hand or an evidence link; it no longer invents a
  hand identity, variant, timestamp, or zero result from malformed success.
- Credit Admin, settlement, and ledger surfaces preserve exact numeric values
  in transport and writes while presenting approved whole/compact chip copy.
  Duplicate financial identities, stale async results, raw storage keys,
  identifiers, ambiguous decimal notes, and malformed records fail closed.
- Insurance, Bomb Pot, Club Financials, and Club Chip Ledger reads now return
  versioned, request-bound envelopes even when the result set is empty. The
  existing implementations remain owner-only cores behind their public
  wrappers; the legacy table-returning Bomb Pot RPC remains intact while the
  client moves to its additive v2 report.
- Settlement History binds every row and account transition to the selected
  club. Rate Audit rejects coerced numbers, malformed rate types, and records
  from another club. Union Statement issuance validates a literal success,
  exact union and period, and consistent counts before it reports completion.
- Dispute submit, review, resolve, escalate, and withdraw mutations return an
  exact dispute receipt and are followed by an authoritative state readback.
  Resolution additionally binds the adjustment type and exact amount. Private
  retained cores are not executable by API roles, and malformed or anonymous
  success can no longer be painted as a completed mutation.
- Union integrity and distribution decisions validate their RPC payloads before
  presenting an operational verdict. Contradictory or malformed results cannot
  be painted as healthy.
- Agent Management is now control-role only at both navigation and route
  capability boundaries. Same-user `42501` revocation clears protected roster,
  form, modal, payable, distribution, and audit state, rejects delayed
  cross-club refreshes, and replace-navigates to the safe operations surface.
  JSON authority refusals and transport refusals share the same fail-closed
  service contract. The finance dashboard presents Agent Management only to
  owner, co-owner, and admin roles; other authorized finance readers receive
  the separate Agent Network door.
- Club Financials performs one scope-bound financial snapshot read per range,
  rejects malformed or contradictory totals, rows, time order, currency, and
  recent-hand selectors, and reuses the verified snapshot across its dashboard
  and rake surfaces. The dashboard no longer exposes a duplicate local mint or
  a raw agent UUID mutation path. Its actions route to the authoritative
  cashier, agent, and dispute consoles.
- Rake reports reject malformed hand and player receipts, require
  gross-minus-returned to equal eligible contribution, reconcile every player
  row to the reported eligible total, validate contribution weights to eight
  decimal places, and reproduce the database's largest-remainder weighted rake
  allocation exactly before presenting the result.
- The browser Financial Health surface is read-only and platform-staff only.
  It no longer represents a partial browser scan, local schedule, or global
  mutation button as an authoritative financial certificate.
- Affected Data and Admin consoles use approved painted families with the
  correct flat foot or complete plate count. Empty painted action plates,
  nested consoles, flat generic controls, and unapproved crest variants were
  removed from the affected graph.

## Retained Regression Protection

- Source contracts cover painted-family foot and plate cardinality, admin
  scope-state rendering, nested-console prevention, title-case and numeric
  presentation, union-scope hand reads, migration preimages/postimages, and
  virtual-list reachability.
- Component tests cover loading, denied, error, malformed, stale, duplicate,
  low-sample, zero-sample, authority-revoked, cross-scope delayed, and
  unknown-value states.
- Production browser coverage verifies positive club-scoped hand counts,
  virtual-list scrolling, responsive layouts, and authenticated route behavior.

## Database Delivery

- `20261006012010_a_resolved_incident_never_predates_its_detection.sql`
- `20261006012714_union_player_hands_follow_shared_tables.sql`
- `20261006024259_drift_consoles_show_only_their_registered_reviewers.sql`
- `20261006032934_owner_stats_keeps_mystery_bounty_truth.sql`
- `20261006035424_owner_notable_hands_carries_scope_receipt.sql`
- `20261006040022_club_reports_return_exact_scope_receipts.sql`
- `20261006040331_dispute_mutation_receipts_name_their_dispute.sql`

Every listed migration is a single-transaction, measured-preimage change with
post-image and security-contract assertions. They must be installed only after
protected merge through the repository's merged-migration workflow, followed
by exact migration-ledger, definition-hash, owner, security, grants, and live
behavior readback.

## Release State

Source qualification, protected merge, migration installation, client
publication, and authenticated production verification are recorded separately
in the task checkpoint. This document does not treat a committed migration or
a successful build as production installation.
