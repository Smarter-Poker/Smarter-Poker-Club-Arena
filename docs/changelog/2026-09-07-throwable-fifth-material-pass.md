# Throwable materials and trash-can closure

Revised the remaining seven original SVG rigs: banana peel, cracked egg, tomato, poop, water gun, trash can and fireworks. Materials now include folded peel interiors, shell and albumen detail, fruit lobes and pulp, irregular coils, molded plastic and wet contours, ribbed metal and tapered firework trails.

Frame review exposed two trash-can failures: the lid inherited its hidden base opacity at the end of its animation, and did not share the returning can’s scale/translation. The lid now rides inside the can-return group and explicitly holds opacity 1 after closure. Flies become visible at their specified 3500 ms beat.

Validation: 51 focused tests across three suites; strict scoped TypeScript; 79 browser beat/size captures; seven enlarged hold views. Browser assertions check 611 unique SVG resource IDs, lid visibility at 3133/3500/4499 ms, flies, 4500 ms cut and reduced-motion closure. Evidence is under docs/throwables/reviews/2026-09-07-fifth-material-pass.

All 18 original rigs have received material revisions. The 30 legacy items, picker replacement, future catalogue phases, remaining audio and authenticated purchase/playback acceptance remain pending in the handoff inventory. This does not claim the entire rebuild is complete.
