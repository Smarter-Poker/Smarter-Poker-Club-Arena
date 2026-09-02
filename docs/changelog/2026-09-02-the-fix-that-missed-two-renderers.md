# 2026-09-02 — The fix that missed two renderers

A follow-up audit of #2674 (the seven mobile lobby fixes), at Dan's
instruction to "go through it all line by line, check for any bugs, stubs,
gaps, errors, regressions or wiring issues". It found four real defects, one
piece of designed-but-dead UI, and the coverage the first PR should have had.

Worth writing down because of the shape of the biggest miss: **the fix was
correct and the wiring was incomplete, so it looked done.**

---

## 1. The zero fallback never reached the two cards a phone shows

`NUMERIC_ZONES` was a private constant inside `ArenaGameCard`'s `LiveValue`.
That covers the NLH, PLO, Spin and Heads-Up machines — and nothing else.

- `MttMachine` paints its own grid areas and hand-rolls six bays as
  `{data.buyIn || '-'}`.
- `NlhPremiumCard`, the layered mobile NLH card **in Dan's own screenshot**,
  hand-rolls three more.

So the tournament board and the cash card a phone actually renders kept
printing a dash while every other bay printed `0`. Nine bays, on the two card
families a player is most likely to be looking at.

The helper moved to `arenaGameCardTypes.ts` as `zoneText()`. It could not live
in `ArenaGameCard` — that file imports `NlhPremiumCard`, so the helper would
have been an import cycle — and the types module is the leaf all three already
depend on. All nine bays call it now, and
`tests/unit/lobbyMobileControls.test.tsx` goes red if any renderer starts
hand-rolling its own answer again.

## 2. The card said "unavailable" out loud

`aria-label` still read:

```ts
${data.players || data.registered || 'player count unavailable'}
```

Once the bays began printing `0`, a sighted player saw `0/6` while a
screen-reader user heard the exact word Dan asked never to appear on a game
card. Two descriptions of the same card, disagreeing. It goes through the same
`zoneText` now, so they cannot drift apart.

## 3. The cache re-persisted its own memory as if it were live

`rememberFigures` was handed the **merged** card — live values plus whatever
had been filled in from storage. A remembered figure was therefore written back
as a fresh observation, which meant:

- the entry could never age out of the LRU, because every render refreshed its
  timestamp; and
- a value the lobby had genuinely stopped reporting would be kept alive forever
  by the very card still displaying it.

The memo returns `{ card, live }` now. Only `live` — what the adapter actually
produced this time — is written.

## 4. `role="toolbar"` without the contract

A toolbar is a composite widget: ARIA expects one tab stop for the group, with
the arrow keys moving inside it. The sort bar shipped with the role and neither
half of the behaviour, which told a screen reader the arrows worked and then
ignored them, and left six separate tab stops in the middle of the lobby for a
keyboard user to walk past on the way to the games.

Roving tabindex with Left / Right / Home / End. Focus is moved imperatively
rather than by rendering `autoFocus`, because the chips are a horizontal
scroller and `focus()` brings an off-screen chip into view on its own — exactly
what a keyboard user wants when the sixth chip is past the right edge of a
375px phone.

Minor, same pass: `GameCreationActions` emitted a trailing double space in its
`class` attribute on every non-compact render, from two false ternaries
interpolating empty strings.

---

## The enhancement: a card showing a remembered number says so

`ArenaGameCard` already had the vocabulary. `dataState: 'stale'` renders a
small 9px "Last Known Game State" chip at the foot of the card —
`inset: auto 9% 10%`, not the full-card overlay the error state uses — and
**nothing in the lobby ever set `dataState`**, so that styling was dead code
and a remembered figure was indistinguishable from a live one.

It is set now, and only when a bay was actually filled from cache, so a card
with complete live data carries no chip and the label clears itself the moment
the real value lands. That is the difference between a cache that is honest and
one that is merely quiet.

---

## Coverage

`src/lib/lobbyFigureCache.ts` shipped with **zero tests** and exported a
`resetLobbyFigureCacheForTests` seam that nothing called — dead code by the
playbook's own Part C rule. Two new specs, 39 cases:

- **`tests/unit/lobbyFigureCache.test.ts`** (17) — the
  partial-write-preserves-siblings guarantee, storing a genuine `0` (a bare
  `if (!raw)` would drop it), LRU pruning at 400, corrupt JSON, a well-formed
  but wrongly-shaped payload, and storage that throws on read and on write.
- **`tests/unit/lobbyMobileControls.test.tsx`** (22) — items 3, 5 and 7, which
  had no pin at all. `GameCreationActions` is **rendered** (ALL → empty DOM,
  each target → exactly one labelled button, no-tab hosts → all four) and
  `zoneText` is **called**, rather than grepped.

### A trap worth naming

Both specs strip comments before any source assertion. That trap bit twice in
one afternoon — once on a CSS function name, once on the phrase "Game
Unavailable" — because this codebase deliberately explains its fixes _in the
file_, so a pin that greps raw text matches the note describing the old
behaviour and reports the bug as still present. `clubPageHardening.test.ts`
already had the guard; these use the same one.

---

## Verification

- `npx tsc --noEmit` — exit 0
- `npx vitest run` over every `*.law.test.ts` plus the 22 specs that read the
  touched files — **59 files, 2116 tests, all passing**
- `npm run build` — exit 0
- All seven original items re-verified by content in the live production
  bundle, not by workflow colour.

### On the red Post-Deploy E2E

It was already failing on `5a598447d`, the commit _before_ #2674, so it is not
a regression from that merge. The run attributed to #2674 also reported
`LIVE_SHA: 5a598447d` — it exercised the previous build, not the new one — and
its extra failures were 30-second timeouts ending in "Target page, context or
browser has been closed", spread across lobby, customization and
tournament-watch specs, with three of the eight lobby cases passing in between.
That is a loaded runner, not a layout change. Recorded rather than waved away,
because the next agent to see that red should know what was and was not ruled
out.
