# The club card, five things at once

Dan, 2026-09-03, with three screenshots:

> 1, SHARK CLUB NEEDS TO BE UP HIGHER. 2, DAN BEKAVAC NEEDS TO BE UP HIGHER
> (AND IT SHOULD SAY THE POKER ALIAS (KingFish) NOT DAN BEKAVAC. 3, THE COPY
> LINK NEEDS TO BE INSIDE THE FRAME AND CENTERED. 4, THE W IN PLAYING NOW IS
> CUT OFF. 5, THERE IS A BLACK BARCKGROUND BENIND THE SHARK CLUB LOGO THAT
> NEEDS TO BE REMOVED.

Four of the five are the same card and were fixed together. The second is not a
layout bug at all, and it is the one worth reading.

Everything below was measured rather than estimated: the shell PNG was
thresholded to find where the artwork actually paints, and the card was
rendered headless at 383x160 (the lobby's 2.4/1), 183px, 320px and 900px with
real Inter loaded, before and after.

---

## 2. "IT SHOULD SAY THE POKER ALIAS (KingFish) NOT DAN BEKAVAC"

He asked for this yesterday too, and yesterday's fix was real but incomplete in
a way that made it useless.

The production row:

| username | alias    | display_name | full_name   |
| -------- | -------- | ------------ | ----------- |
| kingfish | KingFish | Dan Bekavac  | Dan Bekavac |

`playerDisplayName(user, 'arena')` resolves `alias -> username ->
display_name-if-it-is-not-the-real-name`. With the alias present it answers
"KingFish" outright. So the card could only print "Dan Bekavac" if the store it
read held **no alias** — and no `full_name` either, because with `full_name`
beside it the resolver compares the two and refuses `display_name`.

Yesterday I added `alias` to `useUserStore.loadProfile`'s select and stopped
there. Three things were still wrong, and any one of them alone reproduces the
bug:

**a. `setUser` replaced the user instead of merging it.** It rebuilt the whole
`UserProfile` from its argument. Five call sites pass a partial carrying only
`id, username, display_name, avatar_url` off the JWT — two in `IdentityDNA`,
two in `AuthGuard`, one in `useAuthUser` — and one of them, IdentityDNA's
background profile load, runs on a `setTimeout(0)` _after_ `loadProfile`. So
the real sequence on a cold load was: alias arrives, alias is erased, the
resolver falls through to `display_name`, and `display_name` is the legal name
on 264 of 1,308 rows. Yesterday's fix was overwritten about a tick after it
landed.

**b. `IdentityDNA.loadUserProfile` never asked for the name columns.** It
selected `id, username, display_name, avatar_url:arena_avatar_url, tier,
created_at, updated_at, player_number`. There are two profile loaders in this
app and only one of them was fixed. It imports `PLAYER_NAME_COLUMNS` now rather
than retyping the list, so the two selects cannot drift apart again.

**c. Three hydration paths filed a real name under `display_name`.** All three
wrote `display_name: metadata?.display_name || metadata?.full_name`. That is
the arena resolver's last-resort column, so the very first paint printed the
player's legal name, and kept printing it on any route where the full profile
load never ran. The JWT's `full_name` is a real name and goes in `full_name`
now, where the resolver recognises and refuses it — and the social surface gets
a correct one for free.

The `theArenaIsAlwaysTheAlias` law file listed (a) and (c) under **STILL OPEN**
as "a product decision about the World Hub's identity record, not a rendering
fix". That was wrong twice over: those paths write into this app's store on
every load rather than only at sign-up, and the write was destructive.
Deferring it is precisely what left the card reading "Dan Bekavac" the morning
after the sweep meant to fix it. Three new pins in that file now guard the
merge, the `full_name` filing, and the second loader's select.

**One more of the same shape, found while in there.** `setUser` also did
`totalChips: (userData as any).chip_balance || 0`, and `chip_balance` is absent
from every partial — so a player's chip total blinked to zero whenever the auth
listener re-fired. Only a write that actually carries a balance may change one.

---

## 5. The black box behind the logo

There was a silver frame painted into the shell PNG. On 2026-09-02 Dan asked
for it to go; that fix added `.club-identity__logo-mask`, a `background: #000`
div covering it.

The card's ground is a textured quilt, not black. Painting flat black over a
silver box leaves a **black box**, which is what Dan photographed. A mask can
only ever swap one visible rectangle for another.

`club-identity-template-no-level-v5.png` has the frame removed from the pixels,
healed over with quilt lifted from the clean stretch of the same image and
feathered 16px at the border so there is no seam. The mask div and its CSS rule
are deleted. New filename because caches hold the old bytes.

---

## 3. The copy link, inside the frame and centred

Measured off the shell at luminance > 150 (the silver stroke, 1653x951):

|               | x              | y              | centre         |
| ------------- | -------------- | -------------- | -------------- |
| painted frame | 78.58 – 85.60% | 68.35 – 80.34% | (82.09, 74.34) |
| old button    | 75.92 – 85.59% | 65.19 – 81.07% | (80.76, 73.13) |

1.33 points left and 1.22 points high — about 5px and 2px on a 383px card, and
plainly visible in the screenshot. Those old numbers came from the file
header's ARTWORK ANCHORS, which had measured the frame **plus its blue outer
glow**. The glow is not symmetric about the stroke, so a box fitted to it
cannot centre on it. That is why this survived one previous "centre the copy
icon" fix.

The button is the frame's own rectangle now, so `place-items: center` puts the
icon on the painted centre at every card width. The SVG drops 4cqw -> 3.7cqw,
because the opening it sits in is 19.1px rather than 25 and 4cqw filled it. The
header anchors are corrected too, with a note to measure the stroke and not the
glow.

---

## 4. "THE W IN PLAYING NOW IS CUT OFF"

The bay had already been widened twice for this exact complaint, and it cannot
be widened a third time: its right edge now stops at the copy frame. A fixed
`cqw` cannot fit a string that changes — a longer count, or a font a hair wider
than the one the number was chosen against, clips it again. That is also the
whole difference between what Dan sees and what a local harness sees:
production is still on `left: 44%; right: 25%`, and real Inter is wider than
the fallback face.

So it is measured, exactly as the club name above it already was: one
measurement, because text width is linear in font size, then `have / need`.
`fittedPlayingSizeCqw` clamps at 2.05cqw, low enough that no plausible count
reaches it — verified at 183px with **1,204,567 PLAYING NOW**, which fits with
room to spare.

---

## 1. Both top lines sit higher

`.club-identity__name` was `top: 13.5%; height: 11%`. On a 2.4/1 card 11% is
17.6px and the type at the 7cqw ceiling has a 26.8px line box — the text did
not fit its own band, grid centring fell back to start alignment, and the name
hung **below** the box it was supposedly centred in. Measured at 383px: band
13.49-24.49%, rendered text 13.49-30.29%. Every previous attempt to raise it by
nudging `top` was really moving an overflow, which is why it kept reading low.

The band is 18% tall now, taller than the line box at the ceiling, so the text
is genuinely centred and `top` means what it says: 9.2%, centre 18.19% (was
21.89%). Caps land around 13-23% and the painted top rail's inner edge is at
10.30%, so it clears by about three points at the largest size allowed.

The alias moves 31% -> 26%, into the room the name freed. Nothing below moves:
the two ID lines are pinned to icons painted into the shell at 52.37% and
63.36%, so they cannot follow, and the artwork decides where that pair sits.

---

## Verified

`npx tsc --noEmit` clean. `npx vitest run tests/` — 859 files, 11,781 tests,
all passing.

Rendered and read at four widths and two aspect ratios, with a 10-character
name, a 36-character name, an all-W name, and counts from 484 to 1,204,567. In
every case: nothing clipped, nothing wrapped, the copy icon centred on 82.09%,
and no black rectangle anywhere.

Three assertions in `lobbyTournamentBoardDesign.test.ts` pinned the OLD share
box, the old SVG size and the v3 shell. They are updated in this commit rather
than weakened — the rule they guard, "the button occupies the painted frame in
percentages", is unchanged; only the measurement of "the painted frame" is
corrected.
