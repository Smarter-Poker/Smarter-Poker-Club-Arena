# HANDOFF — Club Arena table: what four rounds did not finish

**From:** Claude (Cowork), 2026-08-26
**Repo:** `club-arena` (Smarter-Poker-Club-Arena)
**Shipped already:** PRs #841, #882, #936, #942 — all merged to `main` and verified
serving on production. Do not redo any of that. `git log --oneline -20` will show them.

Read `AGENT-PLAYBOOK.md` and `CLAUDE.md` before touching anything. Claim your own
worktree (`bash scripts/agent-workspace.sh <name> fix/<slug>`), commit early and
often — an auto-reset loop on this Mac destroys uncommitted work — and ship through
a pull request. Never push a red test: `npx vitest run tests/` is what publishes the
bundle. Current green baseline is **414 test files**.

---

## 1. HIGHEST VALUE — five dead components held hostage by leaked global CSS

Five components under `src/components/table/` are mounted **nowhere** in `src/`, and
`src/pages/TablePage.tsx` is their only importer. They cannot simply be deleted,
because each stylesheet declares a **bare, unscoped** class that another page renders
and that **no other stylesheet defines**:

| stylesheet           | orphan class    | who actually renders it                  |
| -------------------- | --------------- | ---------------------------------------- |
| `BankrollWidget.css` | `.stack-value`  | `RebuyModal.tsx`, `AddOnModal.tsx`       |
| `SessionTimer.css`   | `.timer-value`  | `TournamentClock.tsx`                    |
| `StreakBadge.css`    | `.streak-badge` | `LeaderboardPage.tsx`                    |
| `StreamerMode.css`   | `.option`       | `PrivacySettings`, `TableConfigPage`, +5 |
| `CardReveal.css`     | `.cards`        | 20 files, table and non-table            |

So the leaderboard, the tournament clock and the rebuy modal are styled today **only
because the poker table imports a component it never renders.** Dropping the import
unstyles them silently, on screens nobody checks after a table change.

**The job:** for each orphan class, move its rule into the stylesheet of the component
that actually renders it (scoping it under that component's root while you are there —
a bare `.option` or `.cards` in a global sheet is the underlying defect). Then delete
the five components, their stylesheets, the imports in `TablePage.tsx`, and any barrel
export in `src/components/table/index.ts`.

**Verify:** screenshot the leaderboard, the tournament clock, the rebuy modal and the
add-on modal before and after. The reasoning is already written at the top of
`TablePage.tsx` — read it first.

**Also unreachable, same treatment:** `src/components/chips/ChipStack.tsx` + `.css`
(only `src/components/chips/index.ts` references it, and nothing imports that barrel),
and `src/hooks/useTableModals.ts` (its only importer was removed in #936).

**Related ownership bug:** `TablePage.tsx` imports `components/table/ChipStack.css`
_directly_ — it is the only reachable definition of `.chip--partial`, `.pot-label`
and `.pot-value`, which `PotDisplay` and `ChipPhysics` paint on the live felt. That
stylesheet should belong to `PotDisplay`, or become a shared sheet. Do not remove the
direct import until it does. (`PremiumPot`, its other consumer, was deleted in #942.)

---

## 2. LANDSCAPE BREAKS THE SEAT RING — real, unfixed

`src/pages/TablePage.css`, the `@media (orientation: landscape) and (max-height: 500px)`
block (~line 2535) sets `.table-scaler { width: 100%; max-height: 100% }`. A definite
width with a binding `max-height` **beats `aspect-ratio`**, so the scaler stops holding
605/1000 in landscape.

That matters because every seat position in `src/lib/tableSeatGeometry.ts` is a
percentage measured against that aspect, and the painted skin is cropped by
`object-fit: cover` on the same assumption. In landscape the seats are therefore
positioned against a box whose shape no longer matches the artwork behind them.

The same class of bug was found and fixed for portrait in #882 (the installed app was
rendering at 0.71–0.73 instead of 0.605, ring off the rail). `DealerButton` was made
immune in #936 by measuring its own `offsetParent`, and the chips already used the
measured size — **the seats were not fixed.**

Fix landscape properly: give the scaler a real height budget the way portrait now does
(`--sp-page-h` / `--sp-table-h` in `TablePage.css`) so the aspect holds by construction,
rather than being resolved by a clamp. Measure it — a Playwright probe against the real
stylesheet at a landscape viewport, reporting `width/height` and the ratio, is about 30
lines and is how the portrait numbers were established.

---

## 3. THE FELT COULD BE EDGE-TO-EDGE, BUT SIDE PLATES PAY FOR IT

Measured in Chromium at 375×812 after #942: the oval is **367 × 606.6**, width-bound.
Removing the container's 4px gutters gives **375 × 619.8** — the largest possible.

I did not take it. A seat plate is a fixed 96px centred on its ring position, so its
left edge sits at `gutter + 0.105 × W − 48`; dropping the gutters moves the side plates
from 5.5px over the page edge to 8.6px. If Dan wants the extra 8px of felt, narrow the
side seats' plate **in the same commit**, or names pay for the table. The full arithmetic
is in the comment on `.table-scaler` in the `max-width: 480px` block.

Related: at a **320px** viewport a side seat's 96px box overhangs the scaler's left edge
by ~2px and is clipped by `.table-page { overflow: hidden }`. Marginal, but real.

---

## 4. SMALLER, ALL VERIFIED AS REAL

- **`.bbj-info` has never rendered since 2026-08-18.** `.bbj-widget` carries
  `overflow: hidden` (from the sheen pass) and `.bbj-info` is a child at `top: 100%`,
  so the hover rule popover is fully clipped. Needs JS anchoring or a portal. Mobile is
  unaffected (a tap opens `BBJInfoModal`), desktop hover is dead.
- **`.seat--sitout` in `SeatSlot.css` can never match** — the class is emitted as
  `seat--${player.status}` and `PlayerStatus` spells it `sitting_out`. One of the two
  dead rules draws an 'AWAY' pill over the name and stack; renaming it therefore ships
  a **new visual**, which is Dan's call, not a silent fix. Ask him.
- **`SimPage.tsx` declares its own `SEAT_POSITIONS_6MAX`** (~line 33) with different
  numbers from the exported constant of the same name in `src/lib/tableSeatGeometry.ts`.
  A duplicate that has already drifted. Sim-only, low priority, delete the copy.
- **`tableStateRef.current` is assigned inside an effect** (`TablePage.tsx`) and so lags
  one commit, while `winnerInfoRef` and `cardsPreSortRef` assign during render. Current
  code is correct, just one microtask behind. Unifying them means writing refs during
  render, which is unsafe under concurrent rendering and this component uses
  `startTransition`. **Leave it alone unless you have a concrete bug** — noted so the
  next reader does not "tidy" it into a race.
- **`tests/unit/classNamesResolve.test.ts` has a baseline of 43** unresolved BEM class
  names. It is a ratchet; drive it down, do not let it grow.

---

## 5. BUY-IN IDEMPOTENCY — server-side, needs a migration

#936 fixed the narrow case: a `JSON.parse` throw after `atomic_table_buyin` had already
committed used to revert the seat and tell the player "Buy-in Failed. Please Try Again",
inviting a second charge against a wallet that had already paid.

**The general case is still open.** A network timeout _after_ the RPC commits still
reverts the seat and invites a retry. The real fix is a server-side idempotency key on
`atomic_table_buyin` so a repeated call with the same key returns the first result
instead of charging again.

**BINDING — CLAUDE.md §11.5.** Do not probe this against production. A function that
moves money is exercised inside a transaction you **roll back** (`scripts/dev/probe-rpc.sql`
is the pattern), helpers go in `pg_temp` not `public`, and you never `DELETE` a
`table_seats` row to clean up — leaving a seat refunds through `fn_leave_seat_and_refund`,
deleting one destroys the chips. If you cannot probe it without committing, unit-test the
logic and say plainly in the PR that the live path was reasoned about, not executed.

---

## 6. PRE-EXISTING RED, NOT FROM THIS WORK

The scheduled **Live Production E2E** job has been failing all day, and was failing
before any of these four PRs. It is the mobile overflow audit on `/` and `/auth`:

```
/@390: clipped div.sp-carousel__item (right 415)
/@390: clipped div.club-card-panel (right 415)
/@360: clipped div.club-card-stats-row (right 370)
```

Home-page carousel and club cards overflowing at 390px and 360px. That is the World Hub
/ lobby surface, not the poker table. Someone should own it — CLAUDE.md §4 says a red
main is fixed before new work, and this one has been red long enough that people have
started ignoring the signal.

---

## 7. WHAT NOBODY HAS DONE: LOOK AT IT ON A PHONE

Every number in four rounds of work is from the box model, Playwright harnesses against
the real stylesheets, or the bundles served by production. **None of it was seen on a
real device.** The sandbox had no browser for most of it and no network to fetch one.

Before you build anything new on top of this, put a real 375px phone in front of the
table and check: four tabs in the top bar, the BBJ plate's top edge, the hero on the
rail, the action row flush to the bottom, time bank above previous hand with their
bottoms level with the chat button, cards on the inboard side of the side seats, the
dealer button clear of the rail, and both top seats' hands reading as two hands rather
than ten cards. Report what is wrong rather than assuming it is right because CI is green.
