# 2026-08-28 — The action row is sacred, and the sheet you sit down through is reachable

## WaitlistBanner covered fold / call / raise, mid-hand

`position: fixed; bottom: 80; zIndex: 9999`, mounted app-wide from App.tsx.
The action bar is fixed at `bottom: 0` with `--sp-bottom-row-h: 52px` on
mobile PLUS `env(safe-area-inset-bottom)` — about 86px on a notched iPhone —
and its z-index token is 100. So 80 landed INSIDE the bar and 9999 beat it:
a player waiting on a seat had their action row covered by a banner about a
different table, in the middle of a hand.

It now clears the bar BY CONSTRUCTION — the same 52px plus safe-area the bar
reserves, plus a 12px gap — and drops to `z-index: 300` on the token scale
(above overlays, below modal backdrop and toasts) instead of a number chosen
to beat everything. Width capped at `min(90vw, 420px)` so it cannot overflow
a 375px viewport. The 22px dismiss dot keeps its painted size but gains a
44x44 hit area (the pattern ActionPanel already uses for raise-adjust) and an
accessible name; a screen reader used to announce nothing at all.

## BuyInModal — the sheet every player passes through to sit down

Had no dialog semantics whatsoever: no role, no aria-modal, no accessible
name, and NO ESCAPE HANDLER. Clicking the backdrop was the only way out,
which no keyboard can reach. Now `role="dialog"` + `aria-modal` +
`aria-labelledby`, a named close button, and Escape — attached only while
open so it cannot swallow Escape for what is behind it, and refused while a
buy-in is in flight so a confirm cannot be abandoned halfway.

## A money action ran window.confirm

The leaderboard "Pay Out" button used `window.confirm` — unstyled OS chrome
on an irreversible money action, no Title Case, un-dismissable by tapping
outside, and it blocks the JS thread. Now `ConfirmModal` (the in-repo
replacement, 8 other callers) with the confirm latched while the payout RPC
is in flight, so a double tap cannot issue two payouts.

## House rule

`UnionOpsPanel` shipped the words "A Bot Or Colluding Ring" in rendered copy.
AI players are horses, never bots. Fixed.

## Deliberately NOT changed

`ClubSettingsPage`'s unsaved-changes `window.confirm` stays. It runs inside a
capture-phase click interceptor and must be SYNCHRONOUS to call
`preventDefault` on the navigation; a React modal cannot block a click.

## Pinned by

`tests/unit/theFeltStaysReachable.test.ts` (9). Note its `readCode` helper:
every fix here carries a note explaining what the old value was, so negative
assertions run against comment-stripped source — otherwise a correct fix
fails its own test by quoting the bug.
