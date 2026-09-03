# 2026-08-30 — RIT runs 2/3 show the full board again

**Bug (Dan, live hand PLO4 #3769302):** on a turn all-in run 3 times, runs 2
and 3 rendered as a single lone river card. The engine has always sent full
5-card boards (`boards.push([...existingBoard, ...runCards])` in
`ServerTableEngineRunout.ts`), but `TablePage.css` carried a rule that
`visibility: hidden` the shared flop/turn slots on
`.community-area__run--extra` rows, keyed off `data-base-count`.

**Fix:** deleted the hiding rule. Every board row now shows the shared
flop/turn exactly as dealt, plus that run's re-dealt streets. The reveal
timeline is untouched — extra runs still start at the base count and deal
their own remaining streets on cadence.

**Pin:** `tests/rit-full-boards.law.test.ts` fails if any CSS block hides
the shared prefix on extra runs again, and pins the engine's full-board wire
shape.

Also corrected the stale TSX comment at the `data-base-count` attribute in
`TablePage.tsx` (it claimed the prefix "renders dimmed"); that file ships
with its owner's in-flight work.
