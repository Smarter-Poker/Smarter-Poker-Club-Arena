# Ten mobile defects, from the felt (Dan 2026-09-05)

Dan sent ten numbered items with five screenshots, all captured on a phone at a
must-move cash game. They are unrelated to each other except in where they were
found, so this file is one section per item: what he said, what was actually
wrong, and what changed.

Two needed a decision and got one from Dan rather than a guess: the footer
(item 9) and the balancing rule (item 2). Both are recorded below.

---

## 1. JOIN GAME, beside CLOSE, in the Must Move Lobby

> "if a player 'views table' or is in the 'lobby' of a must move game, there
> should be a button next to close that said 'Join Game'"

The door already existed and was only wired to the felt: `joinCashGame`
(`fn_cash_game_join`) was called from `CashClusterHUD`'s waitlist button and
from nowhere else, so a player who opened the lobby to look at the game had no
way in from the thing they were looking at.

`MustMoveLobbyModal` now carries the same call in its header, shown only to a
viewer without a chair in the game. The GAME picks the table, not the button:
one call to the door, which answers with a table or holds the place on the
waitlist, and the modal closes and moves the viewer there. A new `onGoToTable`
prop carries them, the same one `CashClusterHUD` already had, so an embedded
table re-points its tab instead of opening a second one.

**Files:** `src/components/table/MustMoveLobbyModal.tsx`, `.css`,
`src/pages/TablePage.tsx`.

---

## 2. The must-move tables balance themselves

> "feeder games must be balanced, there shouldn't be 3 tables of 9 and one
> table of [3] ... feeder games should stay balanced as best as possible"

Measured from his capture of NLH 0.05/0.10 Classic: **39 players, 5 tables,
9 / 9 / 9 / 9 / 3.**

Nothing had ever moved a player SIDEWAYS. The cluster tick moves players UP
(feeder → a Main with an open seat), OUT (a breaking table onto the shortest
live one) and ACROSS ON REQUEST (a seat change). New joins fill the shortest
Main first and reach the feeder only when every Main is full, so the feeder is
structurally the short one and stays short until it is full enough to promote.

Asked what to aim for, Dan said: **research what the proper table balancing is
for feeder games and mirror that.** It has four parts and this mirrors all four:

1. **The main game is fed, never balanced.** A must-move table exists so one
   full game of that limit is always running; Main 1 is held full on purpose
   and is not in the balancing pool. That half already existed.
2. **The must-move tables are kept within ONE player of each other.** The TDA
   states the same threshold from the other end - full-table play halts on a
   table three or more players short of the largest - so the rule that keeps
   that from ever happening is "within one". Four nines and a three is five
   tables away from it.
3. **A predetermined procedure picks the table**, not anyone's judgement. In a
   feeder chain that order is "starting on the last table and working their way
   to the main table", so ties break toward the newest table giving up a player
   and the table closest to the main game receiving one.
4. **The last to arrive is the one asked to move.** When a room balances into a
   short table it is the newest arrivals who go and the established game is
   left alone. Read off `cash_game_roster.joined_at` - the must-move order,
   read from the other end.

The TDA's "move the next big blind, into the worst position" is **not** used,
deliberately. This database does not hold the button: `tables.first_button_seat`
is a seed, and the running `dealer_seat` lives in `hand_state_snapshots` and
`tables.live_state`, which are the engine's in-flight state and not safe to read
from a planner on a 5-second clock between hands. Moving the WRONG player off a
stale button is worse than moving a deterministic one - and no blind is dodged
either way, because a planned move executes at the player's next hand boundary
and `fn_cash_seat_move_execute` seats them with `entry_hold = 'moved'`, which is
the "post the big blind when it comes round" entry.

A lateral move does not change anybody's place on the must-move list: that list
is ordered by roster `joined_at` across the whole game and is blind to which
table you sit at. That is what makes it safe to make on the room's terms.

**How it runs.** New `fn_cash_cluster_balance(game, now)` plans **at most one
move per game per pass** and is called from `fn_cash_clusters_tick_all` AFTER
the per-game tick, inside the same sub-block - after, because the must-move step
has just filled the main game from the list and balancing against the board as
it was before that would move players the tick was about to move anyway. A
six-player gap closes over about fifteen seconds, one player at a time, which is
also the pace a floor moves at.

Headcounts are PROJECTED (live seats, minus pending departures, plus pending
arrivals), so a table the tick has just promised three players does not read as
short and get three more.

`cash_seat_moves.reason` gains a fourth value, `balance`, and its own sentence:
"Balancing The Tables. Moving To Main 2 After This Hand." - the same string in
the engine (`seatMoves.ts`) and the lobby (`cashGameLobby.ts`), because the felt
and the lobby must never describe one move two ways.

**LAW 10.5:** there is no `is_horse` anywhere in the planner. A horse is
balanced exactly like a human, by the same rule, into the same seats.

**Files:** `supabase/migrations/20260906011318_the_feeder_tables_stay_within_one_player_of_each_other.sql`,
`server/src/services/supabase/seatMoves.ts`, `src/services/cashGameLobby.ts`,
`server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` (the
`fn_cash_clusters_tick_all` pin moved to the new migration, which is now the
live body, plus a new describe for the balancing law).

---

## 3 and 4. The bomb pot pill was one pill doing two jobs

> "The 'double board bomb pot next hand' display and countdown clock needs to
> be MUCH SMALLER ... IT SHOULD BE UNDER THE BLINDS WHERE 'ACTION' IS LOCATED.
> AND SHOULD JUST BE A SMALL COUNTDOWN CLOCK."
>
> "THE 'DOUBLE BOARD BOMB POT' IS COVERING THE TOP OF THE CARDS ... IT NEEDS TO
> BE HIGHER, AND SMALLER, AND IT NEEDS TO BE SMARTER.POKER COLOR SCHEMA, NOT
> PINK."

One element, `.bomb-pot-eta`, carried every state - waiting, counting down, and
the bomb hand itself - pinned at `top: 27%` of the felt. The board sits at 40%
with `translate(-50%, -40%)` on a two-board hand, and the stack grows upward
into that band. So the label that ONLY ever appears on a multi-board bomb hand
was reliably sitting on the boards that hand deals. That is both screenshots.

Split by job:

- **Every countdown state is a masthead line now** (`.table-brand__line--bomb`),
  under the blinds beside ACTION, in the masthead's own tiny type, moving with
  `--sp-brand-top` when a tall stack pushes the masthead down. It sits in
  `.table-brand__meta`, outside the cash/tournament branch, so it is on both.
  `tabular-nums`, so m:ss does not shuffle sideways as the seconds tick.
- **The bomb hand itself** is a small marker, `.bomb-pot-live`, INSIDE
  `.community-area` hanging off the stack's own top edge (`bottom: 100%`) -
  the mirror of what the scoop banner learned on 2026-08-29 when it was
  re-anchored to `top: 100%` for exactly this collision. An anchor cannot go
  stale; a percentage can. Gold on the felt's own dark chrome, the palette of
  the wordmark and the run badge. The magenta arrived on 2026-09-04 from the
  deleted per-seat "BOMB" pills and had no other reason to be there.

The TEXT is decided once, in a `bombPotBadge` memo, so the masthead and the
felt cannot start disagreeing about whether a bomb is coming. Two pins in
`bombPotGuards.test.ts` moved with it: the bomb_pot_only and waiting-for-players
suppressions used to be conjuncts inside the className ternary and are now the
ladder's ORDER - those branches return before any branch that can produce the
pulsing 'next' state, so it is unreachable on such a table. Same guarantee,
different shape, pinned as the shape it now has.

**Files:** `src/pages/TablePage.tsx`, `src/pages/TablePage.css`,
`src/components/table/SeatSlot.tsx` + `.css` (two stale comment references),
`tests/unit/bombPotGuards.test.ts`.

---

## 5. The win banner always comes down

> "THE 'WINS THE POT' ANIMATION IS GETTING STUCK AFTER HANDS SOME TIMES, THAT
> CAN'T HAPPEN, FIX THAT GLITCH."

`winnerInfo` had exactly two ways down and both are events: the reset timer
armed by HAND_COMPLETE, and the next HAND_STARTED. A banner outlives its hand
whenever neither arrives, and there are two live paths to that:

1. **A late or duplicate `pot_win`.** POT_WIN's extend block is gated on
   `handCompleteTimerRef.current`, and the reset NULLS that ref when it runs. A
   `pot_win` landing after it writes a fresh `winnerInfo` and schedules
   **nothing** - so the label waits for a hand that may never be dealt, because
   the table just broke, the hero stood up, or the game closed. This is the
   common one.
2. **A dropped `hand_complete`** (a socket reconnect between the two events):
   the label is set and no reset was ever armed.

The backstop is deliberately NOT a ceiling on how long a win may show. ANIMATION
LAW (CLAUDE.md 10.6) says an animation plays in full at the player's chosen
speed, and a three-board run-it-twice hold legitimately runs past twenty
seconds; a timeout tuned to "a bit longer than usual" would cut exactly the hand
that deserves the celebration most. The test is **whether anything is
scheduled**: while a reset timer is pending this does nothing at all, however
long the hold. It clears only after the banner has stood with NO reset armed for
six consecutive two-second checks - a state that cannot occur during a normal
hand, since HAND_COMPLETE arms the timer ~3s before `pot_win` is even sent. It
clears through `handCompleteResetFnRef` when one exists, so the board, pot,
mucks and stack hold come down together exactly as they would have.

Second half: **the board band had no hand-number fence.** The seat label has
been fenced since 2026-08-27 (`winnerDisplayActive`) because an out-of-order
`pot_win` reads as a win on the hand now being played; the board band took
`winnerInfo.handName` raw. So the seats would go quiet while the band still said
someone had won. Same test, one derivation (`winnerBandActive`), applied to the
band's hand name, its description and the hi-lo low-winner line, on all three
boards.

**Files:** `src/pages/TablePage.tsx`.

---

## 6. The hero's VPIP readout

> "VPIP NEXT TO THE HERO NEEDS TO BE SUBSTANTIALLY SMALLER, AND CLOSER TO THE
> HERO."

It was a 62px-wide card with a 16px figure standing 10px clear of the pod. On a
375px screen that is a second seat sitting next to the hero, and it read as one.
Every dimension is about a third down and the gap is 3px: a readout attached to
the pod rather than a panel beside it. The mechanism is untouched - still
anchored at the hero seat's own point and pushed left by half the pod, so it
rides with the seat at every breakpoint - and the pin in
`heroVpipTrackerAndFeltStyle.test.ts` was rewritten onto the mechanism rather
than the gap, which is Dan's to set.

**Files:** `src/components/table/HeroVpipTracker.css`,
`tests/unit/heroVpipTrackerAndFeltStyle.test.tsx`.

---

## 7. LOBBY moved into the action pill row

> "THE LOBBY RECTANGLE, NEEDS TO MOVE TO ... WHERE THE '4 SQUARE' BOX IS IN THE
> ACTION PILL AREA. AND SAY 'LOBBY' ON IT. (4 SQUARE BUTTON SHOULD BE TO THE
> LEFT OF IT)."

`CashClusterHUD`'s bar read MUST MOVE / LOBBY / PLAYERS n / TABLES n across the
upper-right corner of the felt, over two seats, and the bar WAS the button.
It is deleted. In its place, one word in the multi-table action strip:
`.mtp-lobby-btn`, in the same fixed band as the 4-square button, at the outer
position, with the 4-square stepping left of it by exactly its width plus the
gap - and only on a table that belongs to a must-move game, so nothing moves on
any other table.

That row is drawn by `MultiTablePage`, which cannot reach the felt's state, so
two wires were added: `TablePage` reports `clusterId` in the info it already
reports (the strip needs to know whether there IS a lobby), and the button asks
that table for its lobby over the bus - `OPEN_MUST_MOVE_LOBBY`, addressed by
table id so a strip labelling one screen can never open another's lobby.

What stays in the corner is what the bar was not: the pending-move sentence,
which has to sit beside the seats it is about, and the seat-change / waitlist
buttons, which are actions rather than a readout. Every figure the bar carried
is one tap away inside the lobby it opens. Both pins on the bar moved with it.

**Files:** `src/components/table/CashClusterHUD.tsx` + `.css`,
`src/pages/MultiTablePage.tsx` + `.css`, `src/pages/TablePage.tsx`,
`src/core/MasterBus.ts`, `tests/must-move-lobby.test.tsx`,
`tests/unit/movingAfterThisHandAndTheLobbySaysTheStyle.test.tsx`.

---

## 8. The buy-in slider goes up and down

> "THE SLIDER FOR ADJUSTING YOUR 'BUY IN' NEEDS TO GO UP AND DOWN, NOT SIDE TO
> SIDE. (SIDE TO SIDE SWIPES THE PAGE) REDESIGN THIS PLEASE."

A horizontal drag inside a table is a table-switch gesture, so the one control a
player MUST use to sit down was competing with the navigation for every touch -
and losing, because a swipe that starts on a 6px-high track is a swipe long
before it is a drag. Turning the track vertical takes the control out of that
axis entirely: a fix by construction rather than by tuning a threshold.
`touch-action: none` is the other half - it stops the sheet taking the vertical
drag away as a scroll.

The redesign: the amount and the track are one row, the track standing beside
the amount rather than under it (a 200px-tall track below would push the quick
buttons and BUY CHIPS off the bottom of a 375x812 screen). The min and max were
labels either side of the amount AND the words "Min"/"Max" under the track -
four things saying two; they are the ends of the track now, max at the top where
the thumb reaches it. `writing-mode: vertical-lr` + `direction: rtl` is the standard spelling
(Safari 17.5+, Chrome 121+). The pre-standard
`-webkit-appearance: slider-vertical` is deliberately absent: it is a second
appearance declaration that wins over `appearance: none` and hands the track
back to the UA, so a fallback for old WebKit would have unstyled the control
everywhere else.

While there: `--slider-percent` has been set inline by this component and read
by **nothing** — the element that was supposed to paint the fill
(`.buy-in-modal__slider-track`) lived in the stylesheet and was never in the
markup, so the track had no fill at all. The vertical track paints it as a
gradient stop, growing upward toward the maximum. Nothing about the value, the
step grid or the 2026-08-20 MAX-is-reachable fix changed.

**Files:** `src/components/table/BuyInModal.tsx` + `.css`.

---

## 9. The footer

> "THE FOOTER IS NOT STAYING ON THE BOTTOM WHEN SCROLLING."

Read against the rule Dan made binding the day before - "any other pages that
you can 'scroll up to see more' need this same disappearing footer
functionality" - that is a contradiction, so it was put to him rather than
guessed at. His answer: **keep it, fix the glitch.**

And it is a glitch: the bar was leaving when nobody had travelled anywhere.
Three causes, all fixed without touching the behaviour he asked for:

1. **Four pixels is not travel.** The threshold was 4px. A momentum scroll
   settling, a rubber-band returning, an image finishing its load and reflowing
   the column under you - all cleared it. It is 24px now, about a line of text.
2. **A small inner list is not the page.** The listener is on the document's
   capture phase so it sees a scroll from any scroller, which is the point on
   the Club Arena pages that scroll an inner panel. The cost was that a 60px
   chat log or filter row moving took the global footer with it. A scroller must
   have somewhere to go (96px of range) before it may hide it.
3. **The bottom of a page is a dead end.** At the end of the scroll the code
   returned early - correct in that overscroll must not HIDE anything, wrong in
   that a bar hidden there stayed hidden with nothing below to reveal it. It
   comes back at the end now. Nothing is covered: the clearance below the
   content is reserved whether the bar is up or not.

Nothing eases, delays or waits on a timer. The flip is still the frame after the
scroll event.

**Files:** `src/components/club/useHideFooterOnScroll.ts`.

---

## 10. The header portrait is inside its frame again

> "THE PROFILE PIC IN THE GLOBAL HEADER IS DISTORTED AND NOT IN ITS FRAME."

The image itself could not squash - `.profileAvatar` has carried
`object-fit: cover !important` and `aspect-ratio: auto !important` all along.
The FRAME was wrong, on desktop only.

MEASURED: the desktop rule sets `.profileBtn` to `height: 74%` of the 96px band
and cancels `aspect-ratio` while the mobile `width: 7.15%` is inherited - at a
1680px viewport that is a box roughly 120px by 71px, deliberately not square,
because the black disc has to cover an ornament that `object-fit: fill` squashes
into a wide ellipse up here. The slot inside it was then sized from the WIDTH:
72% of 120px is an 86px circle inside a 71px box that is `overflow: hidden`. The
portrait had its cap and chin sliced off, inside an elliptical black mask.

The slot is sized from the button's HEIGHT now - the axis that actually
constrains it - so `aspect-ratio: 1` gives a 61px circle that fits on every
axis at every laptop width. The disc stays width-derived on purpose. A
`max-width`/`max-height` pair was added to the base slot as well: the button
clips, so a slot even slightly taller than its box does not merely sit
off-centre, it slices the portrait.

The pin in `GlobalHeaderNav.test.ts` required the old `width: 72%` verbatim, so
it was pinning the defect. It now requires the height-derived form and forbids a
numeric width on that breakpoint.

**Files:** `src/components/navigation/GlobalHeader.module.css`,
`tests/unit/GlobalHeaderNav.test.ts`.

---

## The verification pass, and the six things it found

Dan: "before you CLAIM SUCCESS, you need to do a deep dive and verify that
everything you've built is 100% fully built, coded, wired in and tested."
Six real gaps came out of it. None of them would have shown up in a test run.

**1. THE MIGRATION WAS NEVER APPLIED, and the PR could not have merged.**
`scripts/ci/check-migrations-applied.mjs` is a required check: it asks whether
the objects a branch's new migrations declare exist in the LIVE schema, because
in this repo schema is applied to production by hand and the file is the record,
not the mechanism. Read against production, `fn_cash_cluster_balance` did not
exist and `cash_seat_moves_reason_check` still listed three reasons. Applied
2026-09-06 01:13 UTC, one transaction, one schema-cache reload, at minute 13 -
well clear of the :53 freeze. Declared in
`scripts/ci/schema-manifest.d/mobile-ux-batch.json` (the base snapshot is a
nightly and predates it), and the gate now reports
"0 unapplied object(s)".

**Verified live, not assumed:** within 40 seconds of the apply the engine's next
pass had planned **8 balance moves** across the real clusters that needed them -
7/9/3, 6/1, 6/6/4 - with zero `controller_tick_error` rows in the window.

**2. THE PLANNER COULD MAKE TWO TABLES THAT CANNOT DEAL.** Found by reading it
back before applying, not by a test. A cluster holding a live table with two
players beside a live table with none is a gap of two, so the first draft would
move one player and leave 1 and 1 - two tables that cannot deal a hand, made out
of one that could. A room does not balance a thin game, it BREAKS one, and the
tick's step 5 already does that once everyone fits elsewhere. Two floors now:
`hi.n >= 3` (the source keeps two) and `lo.n >= 1` (the destination reaches
two). A live table at 0 or 1 is a break candidate, not a destination.

**3. THE MIGRATION FILE AND THE DATABASE DISAGREED ABOUT ITS VERSION.** The
apply recorded `20260906011318`; the file was `20260906002522`.
`applied-migrations-recorded.yml` runs twice a day and files an issue for
exactly that - a version in the live history with no file on main. The file is
renamed to the recorded version, and the law test and this changelog with it.

**4. A TAP THAT LOOKS BROKEN.** `MasterBus` fingerprint-deduplicates identical
event + payload pairs inside a 500ms window. `OPEN_MUST_MOVE_LOBBY` carries the
same payload every press - the table it labels - so open, close, press again
inside half a second and the second press vanishes. Added to `DEDUP_BYPASS`,
for the reason already written there for `UI_THEME_CHANGED`: an event that IS a
user's tap must never be deduplicated by payload.

**5. THE WIN BACKSTOP COULD STILL CUT AN AWARD ANIMATION.** It waived itself
while a reset timer was pending, which covers every ordinary hand. It did not
cover the case it was written for: a `pot_win` landing after the reset already
ran has no timer to point at, but it still starts chip flights.
`potAwardAnimEndAtRef` - the instant the last flight lands - is now the second
half of the test, so the backstop cannot clear a label while the chips it
belongs to are still moving. That is the animation law's own complaint, and it
would have been in the backstop written to honour it.

**6. TWO DEAD THINGS AND AN EMPTY BOX.**

- `--slider-percent` has been set inline by `BuyInModal` and read by NOTHING:
  the element meant to paint the fill (`.buy-in-modal__slider-track`) was in the
  stylesheet and never in the markup, so the track has never had a fill. The
  vertical track paints it now.
- `-webkit-appearance: slider-vertical` was dropped from the same rule. It is a
  second appearance declaration that WINS over `appearance: none` and hands the
  track back to the UA - a legacy fallback that breaks the modern path is worse
  than no fallback.
- `CashClusterHUD` returns null when it has nothing to show. With the bar gone
  it is a notice and up to two buttons, and a player sitting quietly in the main
  game has none of them; an empty `.cch-column` is invisible but still a
  `pointer-events: auto` node over the felt.
