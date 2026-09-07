# Marketplace Phase 8 - Lifetime VIP Digital Benefits

Phase 8 completes the safe Lifetime VIP digital-entitlement expansion across
Club Arena. Lifetime members now receive included access, without Diamond
debits, to the catalogued gameplay and cosmetic benefits that can be granted
atomically by the existing account-scoped systems:

- Rabbit Hunts
- Standard 20-second Time Banks, subject to the existing two-per-street play
  limit
- Throwables
- Table skins and backgrounds
- Card backs and dealer buttons
- VIP avatar presentation, frames, and auras
- Safe digital feature packs offered through the Club Arena storefront

The normal paid paths remain unchanged for non-Lifetime members. Physical
merchandise, Diamond packages, memberships, tournament value, poker chips,
transferable assets, club creation, and operator inventory are not Lifetime
entitlements. Club Shop revenue remains entirely Smarter.Poker revenue; this
release adds no club commission or revenue share.

## Purchase Safety And Recovery

- Rabbit Hunt, Time Bank, feature, and Throwable mutations use account-bound,
  payload-bound request receipts.
- A replay with the same request ID returns the original result without a
  second debit, grant, or use record.
- A request ID reused for different payload data is rejected.
- Browser request IDs survive reloads and ambiguous responses, while account
  switches cannot apply a late result to another signed-in member.
- Receipt tables are private, deny browser access, and expose only the minimum
  append-only service-role operations.
- Legacy RPC signatures remain temporary compatibility bridges so the database
  can be deployed safely before the new clients.

## Deliberate Safety Boundary

The requested monthly 2,000 promotional Diamonds with 90-day expiry are not
minted by this release. The current wallet is a single fungible balance and
does not preserve grant-lot provenance. Expiring value from that balance could
destroy Diamonds that a member purchased or earned. This benefit requires a
separate promotional-lot ledger, deterministic spend ordering, expiry jobs,
refund rules, reporting, and migration before it is safe to activate.

VIP avatar selection remains enforced by the account-scoped client and
catalogue ownership services. A database constraint was not added because the
profile field legitimately stores several legacy, generated, free, and
purchased URL forms; a narrow trigger would lock out valid existing members.

Printful integration remains deferred as requested.

## Verification

- Independent final source review found no remaining actionable P0, P1, or P2
  defect in the implemented Phase 8 scope.
- Focused Club Arena Phase 8 suites passed 245 of 245 tests.
- Rabbit Hunt, Time Bank, and Pineapple engine suites passed 55 of 55 tests.
- TypeScript, server build, Title Case, painted-text, UI no-em-dash,
  formatting, and whitespace gates passed before release integration.

Production migration, full-suite, build, deployment, and live route evidence
are recorded in the release result for this change.
