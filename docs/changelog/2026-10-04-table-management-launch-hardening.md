# Table Management Launch Hardening

Date: 2026-10-04

## Scope

This release hardens the existing Club and Union Table Management console while preserving the established club-versus-union ownership and game-lifecycle contracts. Union Table Management now recognizes the existing appointed game-operator authority without granting access to broader union finance or data surfaces.

## Operator-facing improvements

- Prevent stale Club, Union, tab, pagination, realtime, and contract-history responses from publishing after the operator changes context.
- Clear route-specific dialogs and busy state when moving between managed organizations.
- Preserve Union member-club names across paged and targeted realtime refreshes.
- Protect unsaved Ticker Management and Club Message Management drafts during browser Back and Forward navigation.
- Replace misleading zero game counts after an unavailable first read with an explicit unavailable/reading state.
- Normalize dynamic status, readiness, contract-reason, and command labels for operator readability.
- Convert the ticker speed control to a touch-friendly vertical control while preserving its complete 8-60 second range and keyboard-accessible native input behavior.
- Align Table Management health, warning, live, ready, and refusal colors with the Club Arena Console palette.
- Keep Add Table, Event, Spins, and Sit N Go creation controls available from every Table Management section, with an explicit fail-closed explanation when a union has no selected house club.
- Add focus trapping, focus restoration, accessible field names, and one guarded dirty-draft close path to the tournament creator.
- Keep the Table Management sections visually separate instead of combining the game board, ticker, and club-message tools into one display window.

## Command-door hardening

- Remove the legacy authenticated browser UPDATE policy and column grants that allowed managed tables and tournaments to bypass command receipts, compare-and-swap checks, and idempotency.
- Preserve authenticated execution of the supported `fn_execute_managed_game_command` gateway and preserve direct service-role maintenance authority.
- Add a native PostgreSQL 17 fixture proving direct browser edit and close refusal, supported receipted close success, occupied-table refusal, registered-tournament refusal, and retained service-role authority.
- Route every migration, fixture, runner, and law-test input into the hosted PostgreSQL accounting verdict.

## Verification coverage

- Added route-change, stale-response, pagination, realtime, contract-history, draft-navigation, and first-read failure regression coverage.
- Added vertical ticker speed-control structure and styling coverage.
- Added an exact Table Management palette compliance gate.
- Added creator accessibility, union authority, ordered realtime refresh, managed-game command-door, and hosted fixture-wiring coverage.
- Verified 800 reviewed source pins and the cash-native manifest after the hosted workflow changed.
- Re-ran the complete scoped Table Management and shared console-law suite before delivery.

## Agent Policy Receipt

- Policy version: 2.9 (2026-09-17), including the 2026-09-29 external-storage amendment.
- Manifest: `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`
- Owner policy: `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
- Operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
- Hardening standard: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
- Reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
- Policy reader: `d5e6189878846064ac60269a41dfc4e6d9a7bda54610110ddc5813230198f36e`
