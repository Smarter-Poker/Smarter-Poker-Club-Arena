# 2026-08-29 — The Dead Table's Name Followed You Around The App

Chasing the three loose ends from the felt test. One was a real defect, two
were not — recorded here because "I checked and it was fine" is worth as much
to the next agent as a fix.

## THE DEFECT: the browser tab kept a table's name after you left it

Observed on production: left a table, landed on `/clubs/club-jaqk`, and the
tab still read `NLH Micro .10/.20 | Smarter Poker`.

`useTableEnvironment` set the title and deliberately did **not** restore it,
on the written grounds that "MultiTablePage's YOUR TURN badge effect owns the
restore." **That premise is false.** The badge effect restores only a title
_it_ badged (`if (!badged) ... else if (badged)`), and it only badges while
the tab is HIDDEN and a live turn is on the clock. In the ordinary case — no
badge ever applied — nothing restored anything, and Club Arena's lobby routes
set no title of their own. So a dead table's name followed the player through
every subsequent page and into any bookmark made from one.

Fixed with the same discipline the badge effect uses, which is also why the
two cannot fight: the effect captures the title it is about to replace, and on
unmount restores it **only if the title is still the exact string it wrote**.
If the badge effect, another table, or a route with its own title has written
since, ours is stale and we leave it alone. Two owners, neither able to
clobber the other. Pinned by `tests/unit/tableTitleIsHandedBack.test.ts`.

## NOT a defect: the "silent" buy-in failure

During the felt test the first buy-in did not seat me (a horse took the seat
between opening the modal and confirming) and I saw no error. Read the path
end to end: every branch of `onConfirmBuyIn` toasts — the explicit
`success:false` refusal routes through `cashBuyInRefusalText`, which names the
specific rule that fired; offline, unparseable body, unmatched branch and the
outer catch each have their own message. The toast fired and auto-dismissed
before I looked, five seconds later. **No change made** — inventing a fix for
a bug that is not there is worse than the bug.

## NOT a defect: "Display NameUsername" in the table menu

That is `label: 'Display Name'` plus `badge: 'Username'` — my DOM scrape
concatenated a label with its state badge. Same for `SoundsOFF` /
`VibrationsOFF`. Working as designed.

## Verification

`npx tsc --noEmit` clean. **Full suite: 612 files, 9,179 tests, 0 failures.**
