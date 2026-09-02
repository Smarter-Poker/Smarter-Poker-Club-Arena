# 2026-08-29 — Hero Hub Max Pass, And "YOUR TURN" Told To People With No Seat

Third pass of the day, and the first one done with a **real seat at a real
table** — Dan, verbatim: "I'VE NEVER SAID YOU COULDNT SPEND CHIPS TO TEST."
(Rule 11.5 is about probing money-path RPCs; it was never about playing.)
Everything below was found or confirmed on the felt.

## 1. THE BUG: "YOUR TURN" fired at players who were not seated

Observed live while SPECTATING a 9-handed table with no seat at all: the
browser tab read `YOUR TURN - nlh 0.1/0.2` the whole time.

`TablePage`'s `onTableInfoUpdate` computed

    currentPlayerSeat === heroSeat && isHandInProgress

with **no `> 0` guards** — the exact 2026-04-14 trap that the felt's own
`isHeroTurnContext` was fixed for and that this reporting path never got. A
spectator's `heroSeat` is 0, and `currentPlayerSeat` is also 0 between hands
and during snapshot churn, so `0 === 0` published `isMyTurn: true`.

That flag is not cosmetic. `MultiTablePage` feeds this one value to the tab
title, the favicon badge, the desktop Notification, the flash/haptic alerts
and the dock countdown. All of them were firing at people with no seat and no
turn — and an "act now" alert that cries wolf stops being believed, which
costs a real hand eventually.

Guarded, and pinned by `tests/unit/turnAlertsNeedARealSeat.test.ts`. **That
pin immediately found a SECOND unguarded copy** — the time-bank reset effect,
which skipped its cancel during exactly the between-hands window it exists
for. Both fixed here.

## 2. Hero Hub: the dialog behaviours it shipped without

It went live as a bare div. Now:

- **Escape closes it**; focus moves into the panel on open, is **trapped**
  inside it (Tab/Shift-Tab cycle), and is **handed back to the hero avatar**
  on close. Previously Tab walked the felt underneath a modal covering it.
- **`aria-modal`**, and every tab now has `aria-controls` pointing at a real
  `role="tabpanel"` that is `aria-labelledby` its tab. The tablist announced
  itself as a tablist while behaving like a row of unrelated buttons.
- **Roving tabindex + Arrow/Home/End** — the WAI-ARIA tab pattern, one tab
  stop rather than four.
- **Visible focus rings** on tabs, items and close.

## 3. A MENU MUST NEVER TIME OUT A HAND

Seen on the felt: the hub opens **over the action buttons**, and the turn
timer does not care that you are reading your own VPIP. When the hero's turn
arrives while the hub is open, the hub now closes itself and hands the felt
back. This is not the `no-auto-table-switch` law — nothing switches tables and
`activeIndex` is never touched; it is the one moment where staying open has a
cost measured in chips.

## 4. The Stats tab now has stats in it

It was a tab containing a single button that closed the hub and opened a
different panel — two taps and a context switch to learn your own stack.
Stack, session P&L, BB won, hands, VPIP and PFR now render inline (all
already computed on the page), with the deep analytics panel kept as a
launcher beneath. Cash-only figures are hidden on tournaments. A value we do
not have prints `-`, never a fabricated `0` — a 0 in a P&L column is a claim.

## 5. The hub says whose hub it is

`aria-label="Player hub"` and it showed no player. Now an identity header:
avatar, name, and live stack.

## 6. Two close buttons that did the same thing

The embedded `ThrowableSelector` drew its own × next to the hub's ×. Hidden
while embedded **from the wrapper's stylesheet** — the component is pinned by
`protected-features.json` and is not forked.

## Live verification (production, real seat, real chips)

Bought in for 40 at NLH Micro 0.10/0.20 as `kingfish`, seat 7.

- **Hero Hub**: tapping my own avatar opened the tabbed hub — Throwables /
  Stats / Profile / Table — exactly the panel Dan asked for.
- **Last-tab memory**: selected Table, closed, reopened → landed on Table.
- **Pre-action no-flash**, sampled at 50ms with a DOM sampler: with
  Check/Fold armed the sequence was `BAR:fold → (nothing)` — **the
  ActionPanel never appeared**. With nothing armed, the same table went
  `BAR:none → PANEL → (nothing)`. `flashesAfterArm: 0` over the whole run.
  That is the controlled before/after, live.
- **Money path**: 495,831.13 − 40 buy-in + 26.10 cash-out = **495,817.23**,
  credited at the same instant `left_at` was stamped. A mid-hand leave
  correctly deferred (`leave_pending`) and settled at the next hand boundary —
  checked, because a leave that navigates away while chips sit on the felt is
  exactly the shape of a real bug. It was not one.

`npx tsc --noEmit` clean; new and existing pins green.
