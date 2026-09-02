# One keyboard, one table — and three more document-level flags fought over by four tables

Dan, after the felt-zoom fix: "CHECK FOR ANY OTHER SIMILAR BUGS... ANYWHERE AND
EVERYWHERE ON THE LIVE TABLE."

Everything here is the **same shape** as the bug that started it: a per-instance
component reaching for a document-level singleton, in a page where
**MultiTablePage keeps up to four `TablePage` instances mounted at once.**

## 1. CRITICAL — one press of F folded every hand hero had action on

`src/hooks/useTableKeyboard.ts` mounted `window.addEventListener('keydown', …)`
per TablePage instance and **nothing consulted which table the player was looking
at.** `isActive` existed as a prop on TablePage (`isActive = idx === activeIndex
&& !hidden`, MultiTablePage.tsx:2559/2741) and was used for sounds, reload
suppression and turn alerts — never for input.

With hero on the clock at two tables — the ordinary case when multi-tabling —
one press of:

| key       | what happened                                                                 |
| --------- | ----------------------------------------------------------------------------- |
| `F` / `Q` | folded **both** hands, into two different pots                                |
| `C` / `W` | called or checked **both**                                                    |
| `A`       | shoved **both**                                                               |
| `M`       | toggled sound once per open table, so with 2 or 4 tables mute did **nothing** |
| `S`       | same, for the stats HUD                                                       |

Each table has its own `actionLockRef`, so the debounce that protects one table
from a double-tap cannot see the other table and never had a chance of catching
this.

**Fix:** `isActive` is now a **required** option on `useTableKeyboard` (no
default — a caller that cannot say which table is in front has to answer the
question), and it is the first test in the handler, before any `preventDefault`
or callback.

## 2. HIGH — TablePage carried a second, near-duplicate keyboard listener

TablePage had its _own_ `window` keydown effect handling F/Q, C/W, R/E and A,
alongside the hook that handles the same keys. Both were live, so on the active
table **every one of those keys ran two code paths per press**; the only thing
between that and a double-submitted action was `actionLockRef` being taken
synchronously by whichever handler ran first.

Its dependency array was `[isHeroTurnContext, handleFold, handleCheck,
handleCall, handleRaise, canCheckRightNow]` and four of those are plain
`const fn = async () => {}` — a new identity every render. So it **tore down and
re-subscribed a window listener on every engine snapshot**, and its own comment
admitted the hotkey's correctness depended on that churn. A keypress landing
between the remove and the add was silently lost.

**Fix:** deleted. Q/W/E moved into the hook. There is one keyboard system.

Three defects fell out of the merge:

- **Keyboard actions did not count VPIP/PFR.** `handleFold` / `handleCall` were a
  parallel implementation of fold and call that skipped the hero-stats block
  inside `handleActionPanelAction` — the function the on-screen buttons call. A
  player who acted by keyboard had their own HUD stats under-count every hand
  they played that way. Both keys now run the button's function. `handleFold` and
  `handleCall` are deleted; `handleCheck` stays because FoldProtectionDialog
  calls it directly.
- **The hook's hero-turn test was a second, unguarded copy.** It was inlined as
  `currentPlayerSeat === heroSeat && isHandInProgress`, missing the `> 0` guards
  that `isHeroTurnContext` carries. Between hands both fields are `0`, so
  `0 === 0` made it true — the exact false-trigger documented on
  `isHeroTurnContext`. It reads `isHeroTurnContext` now.
- **`1`–`4` were bound to two conflicting actions at once.** MultiTablePage binds
  them to "switch to table N" on the same `window`; the hook bound them to bet
  presets. Pressing `2` to move to table two also armed a half-pot raise on the
  table being left. The presets now require the sizing panel to be open
  (`isSizingOpen`) — press R or E first, then `1`–`4` — and when it is closed the
  hook does **not** `preventDefault`, so the table switch still gets the key.
  **This is a judgement call and it is reversible**; say the word if you want the
  number row to size a bet from cold and I will move table-switching instead.

## 3. HIGH — `body.ca-raising` was one flag for four raise panels

`ActionPanel.tsx` set `document.body.classList.toggle('ca-raising', isRaiseMode)`
and five rules read `body.ca-raising …`.

- In **tile view** all four tables paint at once, so opening the slider on one
  blanked the timebank pill, previous-hand card, bankroll widget and chat button
  on **all four**.
- In either view the panels raced. Table two closing its slider — or unmounting,
  since the cleanup's `remove` was unconditional — stripped the class while table
  one's overlay was still open, putting the timebank pill straight back on top of
  table one's slider handle. That is precisely the z-order defect the flag exists
  to prevent, reappearing whenever a second table was open.

**Fix:** the class goes on the panel's own `.table-page` ancestor
(`panelRootRef.current.closest('.table-page')`), and the five selectors became
`.table-page.ca-raising …` — specificity 0,3,0, above the 0,2,1 they replace and
above the 0,2,0 floor rule they must beat. Falls back to `<body>` when there is
no table root above the panel, which is what keeps the component testable alone.

While here: `.bankroll-widget` in that selector list is **dead** — no component
in `src/` renders that class. Left in place and labelled rather than removed.

## 4. HIGH — closing one table switched enhanced view off on the others

`TablePage.tsx` set `data-enhanced-view` on `document.documentElement` with an
**unconditional `removeAttribute` in the cleanup**. Closing one of four tables —
or any instance re-running the effect because its own `enhanced_view` changed —
switched the layer off for every table still open, and nothing put it back: the
surviving instances' effects do not re-run when a sibling unmounts. The player
watched the felt sheen, card faces and pot type revert on tables they never
touched.

**Fix:** refcounted, the same way the viewport lock in `useTableEnvironment.ts`
now is. The flag is on while at least one mounted table wants it.

## Known, deliberate, NOT fixed here

**The two all-in paths still disagree**, and merging them changes behaviour for
one half of the players, so it is not being done inside a sweep:

- `handleActionPanelAction('allin')` — what the **ALL IN button** runs. Counts
  VPIP/PFR. Does **not** fire the client-side Run-It-Twice prompt.
- `handleAllIn` — what the **A key** runs. Fires the RIT prompt from a
  `workerTimeout` after the shove. Does **not** count VPIP/PFR.

Until 2026-08-28 pressing `A` ran **both**, and which one won depended on
listener registration order. Now `A` runs `handleAllIn` only — exactly what it
did before — and the disagreement is documented at both sites.

## Guards

`tests/unit/keyboardBelongsToOneTable.test.tsx` (12 tests). It mounts four
instances of the hook with hero on the clock at two of them, presses `F` once,
and asserts exactly one fold. It also pins: `M` toggles once not once per table;
both alias rows on one listener; the number row untouched (and **not**
`preventDefault`ed) until a bet is being sized; the listener removed on unmount;
and — reading TablePage's source with comments stripped, because this codebase
quotes its own bugs at length — that TablePage registers **no** keydown listener
of its own, passes `isActive`, feeds the hook `isHeroTurnContext`, and routes
fold/check-call through `handleActionPanelAction`.

`tests/unit/actionBarSliderAndFooter.test.tsx` gains a test that renders the
panel inside a `.table-page` host and asserts the flag lands on that host with
`<body>` left clean.

## Results

```
npx tsc --noEmit                exit 0
npx vitest run tests/           510 files, 7994 tests, 0 failed
NODE_ENV=production vite build  built in 11.39s, exit 0
```
