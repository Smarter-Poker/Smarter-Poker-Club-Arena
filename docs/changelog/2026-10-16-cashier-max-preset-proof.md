# Cashier MAX Preset Proof

The Advanced Cashier certificate treated the uppercase rendered MAX action as a numeric amount because its exception matched only `Max`. The shared production assertion now recognizes that exact action label case-insensitively, requires exactly one MAX action and at least one numeric preset, and applies the unchanged compact-figure assertion to every numeric label. Missing actions, missing amounts, duplicate MAX controls and malformed numeric values still fail.

Regressions reproduce the original uppercase failure and cover title/lowercase/whitespace rendering plus nonvacuous and invalid-preset refusals. No runtime, visual, financial or production write behavior changes; the existing wallet, geometry, role, accessibility and read-only Cashier assertions remain.
