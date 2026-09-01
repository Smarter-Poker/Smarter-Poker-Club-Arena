# "Em Bars" Means Em Dashes, And That Misreading Cost The Hamburger Twice

Reverts #2429 and fixes the thing that caused both #2429 and #2321.

## The loop

| When | PR | What happened |
|------|----|---------------|
| 08-31 19:47 | #2321 | "ban three-bar artwork" — gear on all five menu triggers, approved rasters deleted, service-worker tombstones evicting them from players' caches, `noThreeBarArtwork.law.test.ts` making restoration fail CI |
| 09-01 01:23 | #2401 | reverted it, restored the rasters, added `hamburger-never-regresses.law.test.ts` |
| 09-01 10:18 | #2429 | "restore the global three-bar ban" — did it again with a six-tile command grid, tombstones back, counter-law back, my law deleted |
| now | #2432 | reverts #2429 and removes the ambiguity that drove all of it |

Dan opened the app after each of #2321 and #2429 and found a different icon
where his menu button used to be.

## Why it kept coming back

Not stubbornness, and not one bad agent. Dan's copy rule, quoted verbatim in
six files, is:

> "forbid the use of em bars anywhere."

He means EM DASHES — the punctuation mark. But `src/utils/titleCase.ts` renders
the quote as *"inside the entire club arena, and forbid the use of em bars
anywhere"*, and `houseCopyRulesReachEveryPage.test.ts` paraphrases it as *"any
and all m bars ... are banned"*. Neither sentence contains the word
"punctuation", "dash", or "text". Read cold, "bars ... banned anywhere in Club
Arena" is a plausible instruction to remove horizontal bars — and the most
prominent horizontal bars in the app are the hamburger menu.

The loop was then self-sustaining and needed no human in it. #2321 wrote the
ban into `docs/changelog/` and into a law test, so the next agent to read the
repo found a documented house rule, re-enforced it, reverted whoever had undone
it, and wrote the law back. Every agent in the chain believed it was upholding
Dan's instruction. Reverting icons could never fix that; only removing the
ambiguity can.

## The fix

- **Reverted #2429.** Hamburger restored on all five triggers, the three
  approved rasters back at their pinned md5s, cache tombstones removed,
  `CommandGridIcon` and `noThreeBarArtwork.law.test.ts` deleted.
- **Glossed the quote everywhere it appears** — `check-ui-text.mjs`,
  `titleCase.ts`, `popupStyle.ts`, `popupStyle.test.tsx`,
  `houseCopyRulesReachEveryPage.test.ts`, `ci.yml`, and the SQL migration. Each
  now states in the same breath that "em bars" means em dashes, that it is a
  copy rule, and that it does not ban the hamburger.
- **`CLAUDE.md` §10.7** states the rule and both incidents in full.
- **`AGENT-PLAYBOOK.md` opens with it as RULE 0**, because every agent is told
  to read the playbook first.
- **`hamburger-never-regresses.law.test.ts`** now also pins the gloss in all
  six quoting files, the playbook banner, the `CommandGridIcon` and
  `command-center-v1` names, and fails if `three-bar-artwork-is-banned` or
  `noThreeBarArtwork` reappears under `docs/` or `tests/`.

## For whoever reads this next

If something you are reading uses the word "bars" and it has led you toward an
icon, a raster, an SVG path or a header composite: you have misread it. The
hamburger is the menu. Do not resolve the conflict by writing a third law —
two laws demanding opposite artwork is a coin flip decided by whichever test
you happen to notice first.

`npx vitest run tests/` — 790 files, 10,972 tests, 0 failures.
