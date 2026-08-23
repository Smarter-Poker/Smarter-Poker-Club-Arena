# The replay invented a hand that never happened

Date: 2026-08-23
Author: cowork-nofabricate
Severity: integrity. This shipped to players on two live surfaces.

## 1. What it did

`src/components/replay/HandReplay.tsx` is the live hand replay. It is reachable
from two places a player actually goes:

| Surface                            | Where                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| "Replay last hand" at a real table | `TableModalsLayer` -> `<HandReplay handId={lastHandId} />`                                   |
| Hand history page                  | routed at `/hand-history`, `/history`, `/hands` -> `<HandReplay handId={selectedHand.id} />` |

All three of its failure paths called `getFallbackHandData()`:

```
        } else {
          console.warn('Hand not found, using fallback');
          setHandData(getFallbackHandData());   // not found
        }
      } else {
        setHandData(getFallbackHandData());     // no handId
      }
    } catch (error) {
      reportError(error, 'HandReplay.Failed_to_load_hand');
      setHandData(getFallbackHandData());       // ANY error
    }
```

`getFallbackHandData()` was 92 lines returning a fully-formed fictional hand:
invented players (`-KingFish-`, `soul king`, `cubby2426`, `Wizurd`,
`monkey88`), invented hole cards, an invented board, an invented 2,265 pot and
an invented winner.

**So a player who opened a hand that failed to load was shown a hand that never
happened, rendered identically to their own history, with nothing on screen to
distinguish it.** The only signal anywhere was a `console.warn`.

A hand history is the evidentiary record of a poker game. It is what a player
checks when they think something went wrong, and it is what a dispute is
settled with. Fabricating one is worse than showing nothing by every measure
that matters — and it is worse precisely when it fires, because it fires when
something has already gone wrong.

One of the invented names is also plainly unfit to ship.

## 2. What changed

- `getFallbackHandData()` deleted, all 92 lines.
- Not found -> `setHandData(null)`, which reaches the **"Hand Not Found" state
  that already existed in this file and was simply unreachable**, because the
  fallback always populated `handData` first.
- Any thrown error -> new `loadFailed` state, rendering "Could Not Load This
  Hand" with a Retry, kept distinct from "Hand Not Found". They are different
  facts and a player deserves to be told which one is true.
- No `handId` -> no hand. Never invent one for "preview".

`tests/replay-never-fabricates.test.ts` pins it at source level: no fallback
factory, none of the invented names, every failure path landing on null. That
is a stronger property than a render test — it asserts the component has no
capacity to invent a hand at all, rather than that it did not invent one in the
case the test happened to exercise.

The first version of that test failed on the comment explaining the bug, which
would have pressured the next person to delete the explanation to go green. It
now strips comments and asserts on code. Sabotage-tested: reintroducing the
fabrication fails 2 of 4.

## 3. Correction to yesterday's audit in this same repo

`.agent/audits/2026-08-23-the-query-was-fixed-and-the-mapping-was-not.md` §6
claimed `gameplay/HandReplayViewer` was "the only correct DB-backed replay in
the codebase" and that four replay components were unreachable. **Both claims
were wrong**, and they were wrong because that audit searched for `<Component`
in `.tsx` and never checked the router.

The correct picture:

| Component                   | Status                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `replay/HandReplay`         | **LIVE** — table modal + 3 routes. The canonical DB-backed replay. |
| `table/HandHistoryPanel`    | LIVE — in-session records                                          |
| `table/HandDetailModal`     | LIVE — in-session records                                          |
| `gameplay/HandReplayViewer` | orphan (repaired + tested earlier today, still unwired)            |
| `table/HandReplayPlayer`    | imported by 4 files; render sites need checking                    |
| `history/HandHistoryViewer` | barrel export only                                                 |
| `club/HandHistoryModal`     | imported by `HandHistoryPage`; render site needs checking          |

`HandHistoryService` was already mapping the real schema correctly —
`p.userId`, `w.userId`, profile resolution — so the live path never had the
field-name faults `HandReplayViewer` had. The schema knowledge existed in this
codebase the whole time; the orphan just never used it.

**Lesson worth keeping: "is it rendered" is not answered by grepping for the
JSX tag. Check the router, the barrels and the lazy imports.** An audit that
declares live code dead is more dangerous than no audit.

## 4. Decided, and deliberately not done here

`replay/HandReplay` is canonical. `gameplay/HandReplayViewer` is therefore
redundant, however correct it now is, and the remaining orphans should collapse
into the canonical path.

That consolidation is **not** bundled into this PR. It touches barrel exports,
`HandHistoryPage` and `TablePage`, it is pure cleanup with real blast radius,
and shipping it alongside an integrity fix would mean the integrity fix waits
on a refactor review. It gets its own PR.

Also still open, unchanged: `HandRecord.action` is typed
`'fold' | ... | 'all-in'` while the engine stores `all_in`, and
`HandHistoryService` line ~212 casts straight through it
(`a?.action as HandAction['action']`). The value is fine; the type is a lie,
and the next person to write `=== 'all-in'` will get silence.
