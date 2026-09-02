# 2026-09-02 — Seven mobile lobby fixes, from Dan's phone

Dan sent seven screenshots of the Club Arena lobby on a phone. Each item below
quotes him, says what was actually wrong rather than what it looked like, and
names the pin that keeps it fixed.

---

## 1. Nothing renders above the header

> "THE HEADER MUST ALWAYS BE AT THE TOP, AND NOTHING SHOULD EVER APPEAR, OR BE
> DISPLAYED ABOVE IT IN THE PADDING AREA ABOVE IT. THAT SHOULD BE BLACK AND
> NEVER SHOW ANYTHING ABOVE IT."

`.header` is `position: sticky` and pads itself by `env(safe-area-inset-top)`.
On 2026-09-01 #2515 removed its background, on Dan's own instruction — correct
for the artwork, which is opaque across its canvas, but the safe-area band the
element pads by carries no artwork. With nothing painting it, the page scrolling
underneath a sticky header showed _through_ it: in the screenshot, the lobby's
own "FIND YOUR GAME / 280+ GAMES" rows sitting above the header behind the
status bar.

**Fix:** `.header::before` paints exactly the padding band black, stated with the
same expression as the padding — including the standalone-app override, which
pads by `max(inset, 24px)` and would otherwise have left a sliver uncovered.
`.header` itself still declares no background, so #2515 stands everywhere it was
actually about.

**Pin:** `tests/unit/GlobalHeaderNav.test.ts`, deliberately placed directly under
the existing "paints no background" case so nobody relaxes one without reading
the other.

---

## 2. The dynamic ad is no longer cut off

> "THE LIVE DYNAMIC ADD IS CUT OFF ON THE BOTTOM, MAKE SURE THE FRAME ALLOWS THE
> ENTIRE FRAME AND ADD TO BE DISPLAYED."

Desktop was fixed on 2026-09-01 (#2517). The phone cropped for two different
reasons, both invisible to the desktop pins:

- **The ratio was on the padded box.** `aspect-ratio` sizes the _border_ box, so
  a well carrying `padding: 5px 10px 7px` and a 1px border handed its child a
  content box 13px shorter and 20px narrower than 2172/302 — roughly 10px less
  height than the artwork needs at that width.
- **The `<picture>` stayed inline.** An inline box ignores `height: 100%`, so the
  img's own `height: 100%` had no definite parent height to resolve against,
  fell back to its intrinsic height, and `object-fit: contain` — which cannot
  crop — never got the chance to letterbox. The well's `overflow: hidden` did
  the cropping instead.

**Fix:** the ratio moves onto the button, the element that actually draws the
frame, so frame and artwork are the same shape by construction; the picture is a
block; `contain` stays as the guarantee for a club's own `banner_url`, which can
be any shape at all. A superseded earlier block that stretched the ad to fit its
bay is `contain` now too — a rule that distorts the artwork is one cascade
reorder away from shipping.

**Pin:** three new cases in `tests/unit/lobbyCampaignScale.test.ts`, asserted
across every `max-width` block via a brace matcher rather than a `split`. This
sheet has four `min-width: 901px` blocks and the first sits _above_ the mobile
campaign rules, so slicing on the desktop query would have examined an empty
string and passed.

---

## 3. Mobile can sort the board

> "THERE IS NOT FILTERS FOR THE GAME CARDS BELOW, LIKE THERE IS ON DESK TOP, YOU
> NEED TO ADD THAT TO THE BOTTOM, RIGHT BELOW THE DYNAMIC ADD."

Below 900px `LobbyTable` stops being a table — `thead` is `display: none` and
every row becomes a card — so GAME / STAKES / VARIANT / PLAYERS / BUY-IN /
STATUS, which on a monitor _are_ the sort control, had no phone equivalent at
all. The board could be ordered on a desktop and not on a phone.

**Fix:** `.lobby-sortbar`, built from the same `columns` array and calling the
same `handleHeaderClick`. Same keys, same asc/desc flip, same per-club per-tab
memory in localStorage, and the chip set changes with the tab exactly as the
heading row does. A parallel implementation would have been a second set of bugs
and would have drifted the first time a column moved.

Two details are load-bearing:

- It renders **before** `.arena-lobby-card-list`, never between the list and
  `.lobby-table-wrap`, because the desktop table is hidden on a phone by the
  adjacent-sibling selector `.arena-lobby-card-list + .lobby-table-wrap`.
  Anything inserted between those two puts the dense table back on every phone.
- Its chip strip declares **both** overflow axes. `overflow-x` alone computes
  `overflow-y` to `auto`, which is the accidental-scroll-container declaration
  `tests/footer-stays-on-the-footer.law.test.ts` exists to ban.

It also carries its own `role="status"` region: the existing one lives inside
`.lobby-table-wrap`, which is `display: none` on a phone, and a hidden element
announces nothing — so on the one surface that just gained a sort control,
sorting would have been silent.

---

## 4. The footer sits at the bottom

> "THE FOOTER NEEDS TO BE LOCKED TO THE TRUE BOTTOM, THERE IS TOO MUCH PADDING
> AT THE BOTTOM ... MOVE IT SO ITS TRULY AT THE BOTTOM OF THE PAGE."

The bar never moved. `ClubBottomNav` is `position: fixed; bottom: 0` and still
is. What moved was everything above it: the lobby reserved room for the bar
**twice** and then padded that — `.club-home` at `clearance + 44px`, and
`.club-lobby-machine` at `clearance + 18px` in three separate mobile blocks. The
club lobby is a flush route, so the shell reserves nothing and those two were the
whole story: roughly 210px of black under the last game card, for a 78px bar.
That is what a footer floating in a field of background looks like.

**Fix:** the page reserves the clearance once, at `clearance + 12px`; the machine
keeps its 18px visual gap and nothing more. Last card to bar is 30px.

**Pin:** `tests/club-lobby-premium-machine.test.ts` — the assertion moved from
the literal `+ 44px` to the _rule_: the clearance token is still used (not
`--bottom-nav-height`, which omits the home-indicator inset and is what this pin
has always been about), and nothing downstream adds a second copy. A pin on the
old number would have gone red for the fix and stayed green for the bug.

---

## 5. One create button, belonging to the tab

> "THE ADD TABLE BUTTONS SHOULD NEVER DISPLAY ON THE ALL FIELD AND THERE SHOULD
> ONLY BE ONE BUTTON, AND THEY SHOULD BE INDEPENDENT TO THE FIELD. ... ALL PLUS
> SIGNS ... NEED TO BE LOWER SO THEY ARE BALANCED AND PERFECTLY CENTERED WITH
> THE WORDS. ... THIS IS DESK TOP ONLY."

| Tab      | Button      |
| -------- | ----------- |
| ALL      | none        |
| MTT      | + Event     |
| NLH      | + Add Table |
| PLO      | + Add Table |
| LIMIT    | + Add Table |
| SPINS    | + Spins     |
| HEADS UP | + Sit N Go  |

LIMIT is the one tab Dan did not name. It is a cash board — it lists the same
`tables` rows NLH and PLO do, and `table-management?create=table` is the screen
that builds them — so Add Table is the only creation it could mean, and leaving
it blank would make it the single tab with a missing control. The map is
exhaustive rather than defaulted, so a game type added later shows _no_ button
until somebody decides which one it earns.

**The plus sign:** the glyph and the label were two inline boxes of different
sizes — 15px and 11px — sharing one baseline. Baseline alignment lines up the
bottoms of the shapes, so the taller box necessarily rides higher; and a "+" is
drawn near the middle of its em box rather than sitting on the baseline the way
a letter does. Both effects push it up. The button is a flex row now, which
centres the two boxes against each other: the geometric answer rather than a
nudge, and it holds at any font size, at any zoom, and in the compact variant.

**Desktop-only is opt-in** (a `desktopOnly` prop), not a blanket rule on the
component: the union and game-management screens render this same row as their
_only_ route to creating a game, and hiding it there would strip a feature from a
phone rather than tidy a lobby.

---

## 6. One club message on a phone

> "ON MOBILE, THE CLUB MESSAGE DISPLAYS TWICE, IT SHOULD ONLY BE ONCE."

Two elements print `club.lobby_message`, and both are in the tree at every
width: `.club-mobile-owner-message` (ClubHomePage's own strip, written for the
phone) and `.lobby-top__house-welcome` (`ClubOwnerMessage`'s trigger, promoted to
the first row of the desktop rail on 2026-09-01). Below 900px the rail collapses
into the same vertical stack, so "WEST COAST GRINDERS" appeared twice, a few
pixels apart.

**Fix:** the rail trigger is hidden below 900px. The strip is the one that stays,
because it is load-bearing: its 2px left and right borders are two of the mobile
chassis rails, and hiding it would open a gap in the frame between the welcome
plate and `.lobby-top`.

Hiding that trigger would have cost a non-staff player their only way to read a
truncated message in full or reach the club's announcements from the lobby, so
the strip is a live control for **every** viewer now: staff open the inline
editor, everyone else goes to `/clubs/:id/announcements` — the same destination
the rail's panel offered. Removing a duplicate must not quietly remove a
destination.

---

## 7. Cards show the last number we knew, never "Unavailable"

> "IN THE CLUB ARENA LOBBY, THE GAME CARDS SHOULD NEVER SAY UNAVAILABLE, THEY
> SHOULD HAVE 0'S UNTIL THE CARD LOADS. BUT THIS SHOULD HAVE A CACHE FEATURE,
> THAT ALWAYS SAVES THE LAST KNOWN NUMBERS, SAVED AS THE DEFAULT, AND UPDATES
> WHEN IT HAS THE REAL NUMBERS UPDATED."

New `src/lib/lobbyFigureCache.ts`: one localStorage key, an LRU cap, an in-memory
copy hydrated once so a lobby of ~170 cards does not re-parse it on every render,
and a coalesced flush. Absent values are skipped on write, so a partial update
cannot erase a field it did not carry — which is the whole point, because that is
exactly when the cache is needed.

- **`ClubCardPanel`** — MEMBERS / LEVEL / ACTIVE printed the word three times
  across a row of numerals while the live-stats read was in flight. They open
  with the last known figures, fall back to 0, and correct on arrival.
- **`ArenaLobbyGameCard`** — fills only the fields the adapter left undefined, so
  a live figure always wins and a table that genuinely empties shows 0/6 rather
  than a remembered 3/6. `status`, `statusLabel` and `startTime` are deliberately
  not cached: a stale _state_ is a lie that sends a player at a closed door,
  where a stale _count_ is merely a second behind.
- **`ArenaGameCard`** — empty numeric bays print `0`; text bays (game type,
  format, start time) keep the dash, because 0 of a variant is not a thing and
  would be a worse lie than the dash it replaced. The `error` state now reads
  "Last Known Game State" instead of "Game Unavailable": the card is still
  showing figures, so what actually happened is that they stopped being current.

### What was deliberately NOT changed

**Money.** `ArenaWalletRow` and `ArenaJackpotDisplay` still say "Unavailable"
when a read fails, and must. `tests/unit/clubPageHardening.test.ts` records the
incident: a refused money read coerced to 0 painted a fabricated "Diamonds 0"
over a balance that had in fact been read fine, and then persisted the invented
zero for the next visit. `tests/club-buttons.test.tsx` pins the conclusion —
unknown and zero are different facts about somebody's money. A seat count is not
that. Nobody spends "0/6".

If a later reader takes Dan's line here as licence to zero-fill a balance, this
paragraph is the answer: he was looking at game cards.

---

## Verification

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` over every `*.law.test.ts` plus the 19 specs that read the
  touched files — **55 files, 2048 tests, all passing.**
- `npm run build` — exit 0.

Two failures turned up on the way, both mine and both the same cause: the new
sort bar used a colour ramp inside two regions of `LobbyTable.css` that the
live-board redesign pins to flat colours. Those pins scan from their anchor to
the end of the file and match on the CSS function name, so it had to come out of
the explanatory comment as well as out of the rule.
