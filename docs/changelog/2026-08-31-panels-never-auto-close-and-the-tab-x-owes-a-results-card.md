# Panels never auto close, and the tab X owes a results card

2026-08-31 — cowork-claude-table

Three items from Dan, verbatim:

> 1, WHEN YOU ARE PLAYING ON THE LIVE PAGE... YOU CANT CLICK ON THE STATS, OR
> HIT ANYTHING INSIDE THE AVATAR SELECTION AND KEEP IT UP, IT AUTO CLOSES WHEN
> ACTION IS ON YOU AND THAT SHOULDN'T HAPPEN... IT SHOULD NEVER "AUTO CLOSE"
>
> 2, SHOW STACK IN BB NEEDS TO BE A TOGGLEABLE SETTING IN THE TABLE SETTINGS.
>
> 3, ANY TIME YOU LEAVE A CASH GAME, YOU SHOULD GET A "RESULTS CARD" JUST LIKE
> YOU DO WITH TOURNAMENTS, TELLING YOU HOW YOU DID ON THE TABLE.

---

## 1. Nothing the player opened ever closes itself

Three independent mechanisms were shutting panels the player had deliberately
opened. All three are fixed; none shared a cause, which is why the bug survived
earlier passes — closing one door left the other two open.

### 1a. The Hero Hub closed itself the instant the turn arrived

`HeroHubPanel.tsx` carried

```ts
useEffect(() => {
  if (isOpen && isHeroTurn) onClose();
}, [isOpen, isHeroTurn, onClose]);
```

added 2026-08-29 under the heading "A MODAL MUST NEVER COST A PLAYER THEIR
HAND". The hazard behind it was real: the hub renders at `z-index: 900` over an
action bar at `--z-action-panel: 100`, so an open hub hides Fold/Call/Raise
while the clock runs.

The remedy was the wrong one. It took the panel away mid-sentence, and the hub
is the entry point for **Stats, Profile, the avatar picker, Identity and Table
Settings** — so every one of those became unreadable the moment action reached
the hero. That is precisely the complaint.

The hub now **yields** instead of closing. `isHeroTurn` adds
`.hero-hub__overlay--yield`, which:

- drops the backdrop's paint and its `pointer-events`, so a tap lands on the
  action bar underneath rather than on a scrim;
- bottom-aligns the panel above `var(--sp-action-reserve)` — the height the
  action bar already declares on `.table-page` — so the buttons are never
  covered;
- keeps `pointer-events: auto` on the panel itself, so the player can keep
  reading and clicking inside it while they act.

The hand is protected and the panel stays. There is now a comment on that line
saying no close may be reintroduced there under any flag.

### 1b. Every click inside the avatar picker read as a click outside the menu

`AvatarGallery` is a _child_ of `TableMenu` in the React tree but
`createPortal`s itself to `document.body`. Its DOM therefore sits outside both
`menuRef` and `dropdownRef`, so `TableMenu`'s native `mousedown` click-outside
listener fired on the first tile the player touched, closed the menu, and
unmounted the gallery with it.

Both dismissals (`mousedown` and `Escape`) now bail while `showAvatarGallery`
is true. The gallery runs its own focus trap and owns its own backdrop, so
nothing is lost; closing it re-arms both listeners.

### 1c. The same picker, opened from Settings, closed the settings panel

`SettingsPanel`'s backdrop was `onClick={onClose}`. `AvatarGallery` and
`ThemeSettingsModal` are rendered inside that element and portal out — and a
React portal still bubbles its events up the **React** tree, not the DOM tree.
So a click on an avatar tile reached the backdrop handler and closed the whole
settings panel.

The backdrop now closes only when the click landed on the backdrop itself
(`e.target === e.currentTarget`). The panel body's existing `stopPropagation`
stays; it guards a different path.

### Test moved with the mechanism

`tests/unit/heroHubDialogBehaviour.test.tsx` pinned the old rule ("closes
itself when the turn arrives"). Per CLAUDE.md §5.8 the assertion was rewritten
in the same commit rather than deleted: `NOTHING THE PLAYER OPENED EVER CLOSES
ITSELF` now asserts `onClose` is **not** called, the overlay is still mounted,
and it carries the `--yield` modifier.

## 2. Show Stack In BB — already shipped, and now reachable

No code change was needed, and this is worth recording so nobody adds a second
copy. `show_stack_in_bb` is:

- declared in `TABLE_SETTINGS_META` (`useUserTableSettings.ts:194`) as
  **"Show Stack In Big Blinds"**, flagged `quick: true`;
- rendered by `TableSettingsPanel` in the **Table Preferences** section of the
  in-table `SettingsPanel`, and again as a quick toggle on the Hero Hub's
  Table tab;
- persisted to Supabase `user_table_settings` through `useUserTableSettings`,
  one owner, no second writer (`tests/unit/settingsHaveOneOwner.test.ts`);
- consumed by `SeatSlot` (`formatStackAsBB`) and `ActionPanel` via
  `v8Settings.show_stack_in_bb` in `TablePage`.

It was unreachable _in practice_ for exactly the reason in item 1: the Hero Hub
that launches Table Settings slammed shut whenever action arrived, and the
Settings panel closed on the first click into the picker. Item 1 is what makes
this setting findable. A duplicate toggle was deliberately removed on 2026-08-20
(FIX 220) and must not come back.

## 3. The tab X is still leaving a cash game

`handleLeaveTable` — the menu's Leave Table and the felt's leave button — has
published a session summary since 2026-08-18, and `SessionSummaryHost` renders
the cash results card at the app root.

`handleForceLeaveTable` — **the tab strip's X, which is how a multi-tabling
player actually exits** — deliberately published nothing. That was correct when
the summary was a modal rendered ON the table: it would have blocked the very
tab close being requested. It has not been true since the card moved to the
app-root host, which renders over whatever the player lands on and survives the
unmount. All the old behaviour still did was silently swallow the result of a
session that had just ended.

That handler now publishes the same payload, through the same host, with the
same deferred-cashout reconciliation:

- stack and seat are captured **before** `leaveTable` zeroes the seat —
  otherwise the P/L books the entire buy-in as a loss;
- a deferred cash-out reports `chipsReturned: 0`, so the P/L is estimated from
  the live stack and flagged `plPending`, with `pendingCashout` handed to the
  host so it can swap in the settled figure when the `wallet_transactions` row
  lands;
- `heroSeat === 0` (a spectator closing a tab) publishes nothing — a card
  reading "0 hands, 0 profit" is a claim, not a blank (house rule 5);
- a tournament seat still fetches its finish and prize so the host renders the
  ranking card, never a chip-denominated one (Dan 2026-08-20).

One card, two doors, and they can no longer report the same session
differently.

## Verification

- `tsc --noEmit -p tsconfig.app.json` — exit 0, no errors.
- `vitest run` on the specs covering the change — 5 files, **67 passed**:
  `heroHubDialogBehaviour`, `heroHubQuickSettings`, `heroHubLastTab`,
  `settingsHaveOneOwner`, `settingsDoNotChangeThemselves`.
- `vitest run` on the neighbouring laws and the summary host — 3 files,
  **45 passed**: `hero-avatar-opens-hero-hub.law`, `action-bar-never-leaves.law`,
  `sessionSummaryPendingSettlement`.
- A full-suite run in the sandbox reports 8 failures across
  `chipsAreTheDefaultNotBB`, `WaitlistService`, `footer-clearance`,
  `promotions-query-a-column-that-exists.law`, `currentLevelIsAnIndex` and
  `payout-one-rule-everywhere.law`. An identical run against the **unmodified**
  clone produces the same 6 files and the same 8 failures, so none of them is
  this change; they are filesystem and `.git`-dependent guards that a sandbox
  copy cannot satisfy. CI runs the suite for real on the pull request.
