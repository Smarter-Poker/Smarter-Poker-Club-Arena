# No Dollar Signs In Either Arena

Scope: remove dollar signs from all displayed Club Arena and Diamond Arena copy, including stored tournament names, accessible labels, input display and effects. Client-only; no new engine contract, schema or financial changes.

The JSX display boundary removes ASCII and fullwidth dollar signs before rendering text and host display attributes. Machine IDs, routing, option values, callbacks and data objects retain their original values. Game titles, title case and popup formatters also normalize at their display source. Canvas and CSS currency glyphs use chip/win initials.

Owned branch: fix/arena-no-dollar-20261009. Checkout: /Volumes/SmarterWork/agent-work/arena-no-dollar-20261009/client.

Policy receipt: 2.9, emitted 2026-10-09T20:12:37.772Z; manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Canonical owner/operating/hardening/reference files and repository entrypoints read. Base: 15d25de158.

Validation: TypeScript application check passed. Focused 7-file suite passed 893 tests; four no-dollar rendering/identity regressions passed. ESLint passed with two existing MultiTablePage warnings. Production build passed before final browser-title additions; final build and full suite running. Policy integrity passed against canonical sources. Supported GitHub identity and CA origin/Supabase secret names verified (values not read).

Acceptance: no dollar signs in DOM text, accessible labels, display input fields, names, popup output, browser titles and the identified CSS/canvas glyphs in either arena; balances/transactions and machine identifiers unchanged. Publication/live proof pending.
