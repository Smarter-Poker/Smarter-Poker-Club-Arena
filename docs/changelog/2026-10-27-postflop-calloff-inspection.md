# Exact postflop calloff inspection

The existing read-only tournament-refill inspector's v2 selector requires a preflop variant-price reference, so it cannot identify a postflop all-in call. Its new v3 input pins the original hand coordinate, actor UUID, seat and flop/turn/river stage, with an optional exact decision-record hash. At most six cases are admitted; v1 and v2 schemas and selectors remain unchanged.

V3 retains served-source/stable-container checks and original record hashes, accepted-hand binding, unique decision selection, same-turn intended execution, installed receipt validation and full-hand reconciliation. It reports only bounded scalar snapshot fields and existing hash witnesses. Missing contestable pot stays null and is never replaced with public pot. Card values, read contents and raw records never leave the child; Omaha made category is optionally derived through the installed deterministic omahaNutStatus API after validating exact original street/board/card counts and unique physical cards. Absent API or malformed input yields null, without sampling or future-card use. Read-frame presence is only presence, not proof of usable reads.

This is diagnostic tooling, not an engine strategy change, equity replay, qualification or activation. Missing records/APIs and ambiguous or mismatched evidence remain UNKNOWN. No production inspection was dispatched during implementation.

Focused regression: before implementation three new v3 positive/schema checks failed; after implementation the existing inspector suite and added target/binding/privacy/scalar checks pass. Root TypeScript compilation passes. Live evidence remains pending protected delivery and a separately owned bounded inspection.

The diagnostic child also awaits stdout completion before exiting, preserving the pending tournament inspector transport repair without importing unrelated tournament changes. A real backpressured child-pipe regression verifies complete report delivery.
