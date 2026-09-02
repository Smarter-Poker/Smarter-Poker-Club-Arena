# Mobile pass: raise presets, showdown cards, the action pill, the invite page

Dan, 2026-08-28, four items from a phone session, with screenshots.

---

## 1. The raise row is six buttons, not seven

> "WE DON'T NEED ALL OF THOSE MULTIPLIERS. 2.5X 3X 3.5X 4X POT AND ALL IN ARE
> FINE. (REMOVE 2X AND 5X)"

`computeRaisePresets` now uses `MULTIPLES = [2.5, 3, 3.5, 4]` in both branches
that take multiples of a bet. With POT, plus the ALL IN the renderer appends,
the no-limit row is exactly the six he asked for.

**Why the old set was wrong**, beyond his preference: 2X is a min-open preflop
and a min-raise postflop — both already reachable on the slider, neither worth a
button. 5X is past where anyone sizes by multiple. 3.5X never existed despite
sitting between the two most-used buttons. And at seven across a 375px phone the
row was `flex-wrap: nowrap`, so ALL IN was clipped at the right edge — visible in
his screenshot. Six share the width at ~57px each against ~49px, which is enough
room to put the mobile label size back **up** a step (0.625rem → 0.6875rem); it
had only been dropped to make seven fit.

**Pot-limit still truncates**, and that is not cosmetic: `maxRaise` is pinned to
the pot cap, so every multiple above it clamps onto the same number. Preflop all
four are distinct; postflop facing a bet it bites at 3X, so PLO draws
`2.5X 3X POT`.

**No POT preflop in no-limit — I added one and took it back out.** Preflop
unopened the pot is just the blinds, so at 1/2 a pot-sized raise is a raise TO 4:
_smaller_ than the 2.5X button on its left. The row reads left-to-right as
ascending sizes and a POT that undercuts every multiple breaks that. Pot-limit
keeps its preflop POT because that sizing is the game.

## 2. A tabled hand is never below the avatar

> "THE SHOW DOWN CARDS MUST ALWAYS BE ON TOP OF THE AVATAR, NEVER BELOW, THE TOP
> VILLAINS CARDS ARE COVERING THE POT."

`.seat-wrapper--top .seat .seat__cards--opponent.seat__cards--revealed` read
`top: auto; bottom: calc(-1 * var(--vh-card-h) - 6px)`. That dropped a top-cap
seat's tabled hand a full card height **below its own nameplate**, onto the felt
— where the pot lives (`.pot-display`, top 38%) and where
`.seat-wrapper--showing` sits at z-index 30 against the pot's 20. So it painted
over the pot total. Exactly the screenshot.

It now uses the base anchor (`top` + `translateY(-100%)`), keeping only the
horizontal centring, so the hand grows **upward over the avatar** like every
other seat.

**The reason the old rule existed is no longer true**, and that is worth
recording so nobody re-adds it. It was guarding against a top-cap reveal being
drawn into the Bad Beat Jackpot banner. Measured as the reveal actually is now: a
top-cap avatar token is 56px, so a revealed card is
`max(17px, 56 * 0.346 * 1.6)` = 31px, and the cluster's bottom edge is pinned 1px
above the plate at `56 - 6 - 1` = 49px down the seat. Its top edge lands 18px
below the seat's own top edge — it never reaches the banner. The collision it
guarded against cannot happen at this size; the one it caused happened every
showdown.

Two stale comments pointing at `bottom: calc(100% - 10px)` — a declaration that
had not existed in the repo for two moves, so a reader following the pointer
found nothing and reasonably concluded the row was unowned — were corrected in
`SeatSlot.css`.

**A third one, in `TablePage.tsx`, is deliberately NOT in this commit.** That
file is 923KB and moved twice under me while this branch was open; carrying it
here means a three-way merge of the whole thing on every push, and re-merging a
million bytes to fix one comment is a bad trade with a real chance of dragging
something in sideways. It is `TablePage.tsx`'s `seat-wrapper--showing` comment
and it wants its own one-line commit.

## 3. The action pill shows cards and the timer bar

> "THE ACTION PILL SHOULD ONLY EVER SHOW THE CARDS (CENTERED IN THE PILL) AND THE
> DISAPPEARING TIMER BAR... THATS IT, NO COUNTDOWN CLOCK OR ANYTHING ELSE."

Two changes in `TableTabBar`:

- **`.table-tab-bar__turn-dot` is deleted**, markup and CSS and both keyframes.
  It was the green "14s". It also answers the "(CENTERED IN THE PILL)" half: the
  pill centres its in-flow children, and the badge was one of them, so the cards
  sat off-centre for exactly as long as it was the hero's turn — the one moment
  the pill is being looked at. That is fixed by deleting the badge, not by adding
  alignment.
- **`hasCards` is now the first branch.** It was third, so a decision prompt or
  an engaged time bank _replaced_ the hero's hand with a text countdown — and
  both only fire while the hero holds cards, which made them the common case.
  The label branches still render when there is genuinely no hand, so no state
  falls through to a blank pill.

Nothing about urgency was carried by the badge alone: `isUrgent` still drives
`--urgent` on the pill and on the bar, and `--flash` still fires under 5s.

## 4. The invite page

> "IF YOU ARE ALREADY A MEMBER YOU SHOULD NEVER EVER EVER SEE THIS... AND IT
> NEEDS TO BE FULLY UPGRADED, ENHANCED AND OPTIMIZED. NEEDS TO BE FACEBOOK COLOR
> SCHEMA AND LOOK BETTER."

**Members are redirected in.** An active membership row now calls a new
`enterClub()` helper instead of rendering a "You're Already A Member!" panel with
an Enter Club button — a dead end whose only function was one more tap to reach
somewhere they were already entitled to be. `replace: true` is the important
half: a push would leave this page on the stack, so Back from the club lands
here, the member check runs again and throws them forward, and the Back button
looks broken. All three "you are in now" exits (member redirect, pending
redemption, successful join) route through the one helper; they used to be three
`navigate()` calls with slightly different arguments.

**Rebuilt twice.** The first pass was the Facebook palette he asked for
(#1877F2 / #F9FAFB / Inter). He then sent three reference cards with "CUSTOM
SWAP, CUSTOM MAKE AND DESIGN THEM, BUT THEY SHOULD LOOK AND FEEL LIKE THIS", and
those supersede it: black glass inside a brushed-steel bezel, blue neon down the
long edges, gold Cinzel display type, a deep blue metallic button. It belongs to
the felt it sits beside, which the light card never did.

**Built entirely in CSS**, which is what "custom make and design them" has to
mean here — shipping the mockups as three PNGs would fix the width, add three
requests and need a re-export every time a colour moves. The bezel, its bevels,
the neon, the ornamental rules, the gold chip and the plaque are gradients,
borders and shadows. `.invite-frame` IS the metal (its padding is the bezel
thickness) with two blurred pseudo-elements for the neon; `.invite-card` is the
black glass inside it. Icons are inline SVG on `currentColor` — never emoji
(house rule 5, and emoji break SWC).

Structure follows the references: gold-ringed logo in a blue halo, silver
gradient club name, gold tagline between two hairline rules, a gold-bordered
member chip, an ornamental divider with a lit diamond, and the club's own name
picked out in gold inside the invitation sentence. The error card gets the
"Club Invite" plaque and a red warning disc, because with no club to name the
plaque is what says which page this is. 48px tap targets.

Every gradient heading sets a plain `color` FIRST as a fallback: the one failure
mode of `background-clip: text` with a transparent fill is a browser that drops
the clip and renders an invisible heading. A test pins that.

**Copy is Title Cased, which CI taught me.** I wrote the page in sentence case
and `scripts/ci/check-title-case.mjs` failed the build — Dan 2026-08-21, "first
letter of every word is capitalized, that's a hard rule for all forward facing
pages." Its `--fix` is the sanctioned tool, but its output for a contraction is
`You&apos;Ve` and `You&apos;Ll`, because an apostrophe starts a new word. That
artifact is visible in Dan's own mockup ("Club'S Tables"). So the headline is
"You Are Invited To Join" and the pending body says "Access Is Granted Once Your
Request Is Reviewed" — written round the contraction, which satisfies the rule
AND reads properly rather than satisfying it and looking broken. The two
sub-lines stay sentence case: they are `{}` expressions, which the gate
deliberately does not touch, and Dan's reference card shows that line in sentence
case.

**Every selector is now namespaced under `.invite-page`, and that is a bug fix.**
This stylesheet is a plain global, not a module, and it declared bare
`.club-name`, `.club-description`, `.club-stats` and `.join-btn` — all four are
live class names in ClubDiscovery, HomePage, FavoriteTablesWidget,
TournamentLobbyPage and ClubSettingsPage. Whichever stylesheet the bundler
emitted last won, so this page's typography was landing on the club discovery
grid and the favourite-tables widget.

**Dead code removed with it:** the share panel rendered only in the
`alreadyMember` branch, so it, the invite-URL effect that fed it (a `profiles`
round trip on _every_ load, purely to build a `?ref=`), the clipboard handler and
the `qrcode.react` import were all unreachable. Also removed an unused
`SHARK_CLUB_ID` import and fixed a missing `enterClub` dependency that eslint was
warning about.

**Verified nothing was lost before deleting.** A member can still get this club's
invite link, with their own `?ref=`, from three places that need no role: the
share button in the club lobby header, "Share Club" on Club Settings (one tap
from the bottom nav), and the referral banner on the club Promotions page.

**One thing was lost, and Dan should decide where it goes: the QR code.** It
existed only on this page — the sole `QRCodeSVG` in `src/`. It belongs on one of
the three surfaces above, not on a page a member can no longer reach. Not done in
this commit because it is a different page and he did not ask for it.

---

## Tests, all updated in the same commit

- `actionpanel-raise-presets.test.ts` — every row assertion rewritten to the new
  set; the "five DIFFERENT numbers" beats are now four; the PLO pot-cap beat was
  passing `maxRaise: cap` **without** `isPotLimit: true`, so despite its describe
  block it exercised the no-limit branch and never saw the POT button — fixed
  while it was open. The row-width guard tightened from seven buttons to six:
  leaving it at seven would let the row grow back into the state that clipped
  ALL IN.
- `seatCardsAndPlate.test.tsx` — two new beats. One forbids a `bottom:` anchor on
  ANY revealed villain cluster (the regression itself, checked as a shape rather
  than as pixel values); the other pins the top-cap anchor and requires the
  transform to restate `translate(-50%, -100%)`, since centring with a bare
  `translateX` silently drops the bottom-edge anchoring. Verified both would fail
  against the old CSS.
- `tabBarQuietWhileObserving.test.ts` — the beat that pinned the turn dot now
  asserts its absence, matched on the rendered `className` rather than on the
  string, so the comment recording why it went can still name it.
- `e2e/multi-table.spec.ts` — fixture no longer mounts the deleted badge; two
  beats renamed and their badge assertions dropped.
- `tests/unit/inviteIsForPeopleWhoAreNotMembers.test.ts` — new. Pins the
  redirect, the `replace: true`, the single-helper routing, the absence of the
  old copy and the dead `profiles` query, the gold/neon/steel palette, that the
  frame is DRAWN rather than referencing an image, that no gradient heading can
  end up invisible, the tap-target minimum, and the CSS namespacing.

## Verification

- `npx tsc --noEmit` — exit 0. `npx eslint` on all four changed sources — 0
  errors, and the two pre-existing warnings in InvitePage fixed.
- `npx vitest run` over 28 suites covering every file touched — 558 tests, all
  passing.
- `prettier --check` clean.
- The redesigned invite page was **rendered in Chrome at 375px** against its real
  stylesheet, in all three states (join, pending approval, bad link), and looked
  at before shipping.
- Playwright browsers are not installable in this sandbox, so `multi-table.spec`
  and `hero-card-row.spec` run for real in the required **CSS Beat E2E** check on
  the pull request.
