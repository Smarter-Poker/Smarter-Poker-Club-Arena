# Table Management Final Recertification

Date: 2026-10-04

## Scope

This follow-up re-audits the Club and Union Table Management delivery on current protected main. It keeps the established game-command, lifecycle, authority, ticker, message, creator, and distinct-frame contracts unchanged while closing three concrete gaps found during post-merge certification.

## Repairs

- Union Games now binds errors from the Union, member-club, tournament, table, and bad-beat-pool reads. A failed read reports through the existing error reporter and displays an accessible retry state instead of a false zero-game `LIVE` page.
- Club Table Management retains the authoritative game-creation access result and distinguishes a Union-affiliated revocation, an insufficient standalone-club role, an unavailable access check, an unknown club, and a signed-out visitor. It no longer claims every denied club joined a Union.
- Table Config replaces the floating generic double-chevron glyph with the clear Title Case `Back` label while preserving its existing accessible name and navigation handler.
- The read-only production certificate now checks phone-width horizontal overflow across the board, ticker, messages, Add Table, Table Config, Event, Spins, Sit N Go, and Union-refusal compositions.

## Regression Protection

- Added a five-read Union Games failure matrix that requires an alert, retry control, reported error, and absence of the `LIVE` board.
- Added rendered refusal coverage for Union affiliation, insufficient standalone-club authority, and an unavailable authority check.
- Added a source contract forbidding the generic Table Config navigation glyph.
- Extended the existing ten-case production Table Management specification without adding any submit, save, close, delete, or mutation action.

## Delivery Classification

This is a Club Arena client-only correction. It adds no engine contract and no database migration.

## Agent Policy Receipt

- Policy version: 2.9 (2026-09-17), including the 2026-09-29 external-storage amendment.
- Manifest: `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`
- Owner policy: `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
- Operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
- Hardening standard: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
- Reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
- Policy reader: `d5e6189878846064ac60269a41dfc4e6d9a7bda54610110ddc5813230198f36e`
- Audit base: `715713d8039f1155e1fd0197acc1514745fbd476`
