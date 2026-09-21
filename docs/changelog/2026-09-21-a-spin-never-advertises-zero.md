# A Spin never advertises zero, and the lobby hands down what it already read (2026-09-21)

A line-by-line audit of `/tournaments` and the card it lists, after the console
re-land (`#4696`) went live. Three defects, all of them live on `main` at the
time of writing, none of them cosmetic.

Before/after at 393px: [`shots/sheet-spin-card.jpg`](./shots/sheet-spin-card.jpg).

## 1. Every Spin on the board advertised a prize pool of zero

`prize_pool` for a Spin is written at START, beside the drawn multiplier
(`TournamentManagerBase`), so a REGISTERING Spin carries `0`. The card printed
that straight through `compactChips`, and every filling Spin on `/tournaments`
read:

    PRIZE POOL        0

That is a real number a player reads before deciding to put real chips in, and
it was not a true one. It is also the worst possible number to show for a
format whose entire proposition is the size of the prize.

The main lobby has had the correct rule since the Spin format shipped, written
down in `lobbyEntries.spinPrizeLabel` with Dan's own words: **before the draw a
Spin advertises the top of the ladder; after it, what it actually pays.** The
card now asks that same constant (`SPIN_MAX_MULTIPLIER`) and that same reveal
gate (`utils/spinReveal`) rather than growing a second spin rule in a second
file (10.11: one rule, one place):

| state              | card reads                                        |
| ------------------ | ------------------------------------------------- |
| registering        | `TOP PRIZE  300` and `MULTIPLIER  Win Up To 100x` |
| running, drawn 25x | `PRIZE POOL  1.2K` and `MULTIPLIER  25x`          |

Three details that are the rule, not decoration:

- **The reveal gate is asked, never re-implemented.** `spinMultiplierLabel`
  returns nothing until the tournament has actually started, so a row that
  happens to carry `spin_multiplier` early cannot leak the draw to a player
  still deciding whether to sit. Pinned.
- **The ceiling is a ratio, not a promise of a draw.** "Win Up To 100x" is the
  ladder; "Top Prize" is `buy-in x 100`. Neither claims the wheel has turned.
- **A stale row still prints the truth.** If the realtime update lands before
  the re-read, `prize_pool` can still be `0` while the multiplier is drawn; the
  pool is then derived as `buy-in x multiplier` instead of printing `0` again.

`spin_multiplier` is now in the lobby's column list, which is what makes any of
this readable. **The reason for it is written ABOVE the template literal, not
inside it** - a PostgREST column list is sent to the server verbatim, so a block
comment in those backticks becomes part of the query. That cost one red
typecheck here and is now pinned so it cannot cost a second.

## 2. A failed registration read told every card the player was not registered

The lobby reads every one of this player's registrations in one query. It ended:

    registrations = regData?.map((r) => r.tournament_id) || [];

A **failed** read produces `undefined`, `|| []` turns that into an empty list,
and an empty list is indistinguishable from "registered for nothing". So a
Supabase blip during load did not show an error - it showed a board of live
**Register (buy-in)** buttons to a player who was already in every one of them.
Pressing one is a second entry attempt against real money.

This is CLAUDE.md 10.86 rule 1 exactly: "I could not tell" is a distinct outcome
and must have its own name. It is carried as `null` now, reported through
`reportError`, and `null` survives into the view model instead of collapsing to
`false`. `TournamentLobbyCard`'s `knownRegistration` contract already had the
third outcome built in - it only short-circuits on a real boolean and otherwise
looks the answer up itself - so `null` means "my batch read failed, go and check
for yourself", and the card does.

### The same shape twice more, in the same file

The discarded-error-read ratchet had this page frozen at **3**, and lowering it
by one is what made the other two visible. Both are union reads, and both turned
an unreadable row into a confident answer:

- **Union membership** decided whether Create Tournament is offered. A failed
  read read as "standalone". The outcome is deliberately unchanged - fail OPEN,
  because refusing that affordance on an unreadable row hides the only way out
  of an empty board from every standalone club during a blip, and the server
  refuses a union club's create anyway - but it is now a decision rather than an
  accident, and the failure is reported.
- **Union scope** decides which tournaments the board may list at all. A failed
  read read as "no union", which quietly drops every union game. The fallback
  was already the safe direction (this club's own games, never a sibling's
  private ones) so nothing widens; what changes is that a union player looking
  at a board with the union's games missing now leaves a trace of why.

The file's baseline is **0** now, and kept at 0 rather than deleted so a
reintroduction shows up as a diff on that line.

## 3. The same read was thrown away, and every card asked again

`TournamentLobbyCard` accepts `knownRegistration` precisely so a listing page
that has already read the answer can hand it down; its header has documented
that since 2026-08-25. The lobby never passed it. Each card therefore ran its
own `tournament_players` lookup on mount, and on a seventy-two-hour board that
is twenty to forty extra round trips per page load for a question answered
before the first card rendered. One prop.

## Two smaller things found in the same pass

- **The time windows were not headings.** Each window (`Now`, `Next 3 Hours`,
  `Later Today` ...) was a `<div>` with a `<span>`, so a player running a screen
  reader down the board had nothing to tell them where one window ended and the
  next began, and the bare count beside the label announced as "Now 1" with
  nothing to say what the 1 counted. They are `<section aria-labelledby>` with
  an `<h2>` now, and the count carries its unit.

  Promoting a `<span>` to an `<h2>` is not free and the first draft of this
  note claimed it was. `globals.css` and `club-engine.css` both give `h1`-`h6`
  a `line-height` of 1.2, where a span here inherited the body's 1.6, so the
  swap would have shortened the row. It happens not to, because `.groupCount`
  beside it is still a span at 1.6 and the row is `align-items: baseline` - but
  that is the sibling holding the height open by luck, and it would end the
  first time the count moved. `.groupLabel` declares the 1.6 now, so the
  promotion is inert by construction. Size, weight, letter-spacing and case
  were already `.sc-label`'s, the colour is `sc-ink--blue`'s, and the UA margin
  dies on `* { margin: 0 }`.

- **Search reported nothing.** Typing in the field silently re-filtered the
  board; the result count only exists on the console's pill. It now announces
  "N Tournaments Found" through a `role="status"` live region tied to the input
  by `aria-describedby`. Announced, never drawn - the console paints no status
  line (`.srOnly`).

## The evidence that had no home

`docs/changelog/2026-09-20-...md` pointed at `shots/sheet-tournament-lobby.png`
and `shots/sheet-tournament-card.png`. Those sheets were rendered and reviewed,
and then left in the harness's scratch directory, so the reference resolved only
on the machine that made it. Both are committed beside that changelog now, as is
this one's, and the harness's `sheet.py` no longer dies with a `truetype` error
on a Mac because its font list knew only Linux paths.

## Tests

- `tests/unit/aSpinCardAdvertisesTheLadder.test.tsx` - the ceiling before the
  draw, the real pool after it, the derived pool when the row is stale, no leak
  of a pre-start multiplier, and every non-Spin card unchanged.
- `tests/unit/theLobbyHandsDownWhatItAlreadyRead.test.tsx` - the `knownRegistration`
  wiring, the nullable read, the card's `typeof === 'boolean'` contract, and that
  no block comment lives inside the PostgREST column list.
