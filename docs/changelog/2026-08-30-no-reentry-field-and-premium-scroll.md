# 2026-08-30 — No Re-Entry field, and the premium console scrolls

Dan, verbatim: "IT SHOULD NEVER HAVE 'RE ENTRY' AS A FIELD, ONLY REBUYS...
AND EACH PAGE NEEDS TO BE SCROLLABLE UP AND DOWN. YOU CURRENTLY CAN'T."

1. The Entries tab's Players card carried a "N Re-Entry" sub-label. Removed —
   Entries, Players and Rebuys are the vocabulary.

2. The 2026-08-30 one-scroller overhaul fixed `.details-content` on the BASE
   stylesheet, but the premium console skins the same element with the
   higher-specificity `.tournament-details .details-content` — a layer where
   any future property can silently cost the scrollbar and nothing pins load
   order. The scroll contract (flex, min-height 0, overflow-y auto) is now
   restated at that winning specificity, so the metal-frame console scrolls
   no matter what the skin adds next.

Pins: tests/unit/noReentryFieldAndPremiumScroll.law.test.ts. 672 client test
files green; typecheck clean.
