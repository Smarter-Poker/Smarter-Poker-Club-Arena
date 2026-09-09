# The wheel recut, and the floor

**2026-09-09. Dan: "move onto the next phase of this complex build and upgrade
phase for the 3 diamonds to chips games." Earlier the same day, on what to
build next: "THIS IS ON YOU TO DECIDE."**

Continues `docs/changelog/2026-09-09-the-diamond-games-open.md`.

## The wheel, recut in the console's material

After the console rebuild, one thing on the wheel page still did not belong
to the chassis around it: the wheel. It was drawn gold and cyan, set in a
cavity it painted for itself in CSS (its own radial fill and inset shadows -
one background inside the frame and another outside it, which the standard
names as a fault). Next to a chrome console with blue lamps it read as a
prop from a different set.

It is now cut from the same material. A brushed-chrome rim, the console's
own gradient (bright at the top left, dark at the bottom right, the way the
master's rails turn), set with the frame's blue LED lamps, dark at rest and
chasing while the wheel turns. The segments are steel-blue glass with
engraved silver labels; the diamond segments are the club's blue; gold is
the top ink and stays rare, so only the two biggest chip prizes wear it.
Chrome spokes between the segments, a chrome pointer with a lit blue tip, and
in the hub the same cut stone the Diamond Games mark carries, so the wheel
and its door agree. The cavity is gone; the rim's own shadow grounds it on
the glass.

## The floor

A casino floor is loud with other people winning. These three games were
silent rooms: a player arriving saw their own history, which the first time
is empty, and nothing else. An open game with a full pool looked like an
empty room, and an empty room is not a casino.

`fn_diamond_game_floor` (migration `20260909230222`) is one STABLE read that
returns the host's recent wins across the wheel, the board and the curve,
named the way the club already names a winner: `fn_arena_name` for the name
and `profiles.arena_avatar_url` for the picture, exactly as
`fn_bbj_recent_hits` does it, resolved on the client through the same
`getAvatarWithFallback` the felt uses, so a winner with no avatar gets a
monogram rather than a broken image. It returns no user id (a bare id can be
joined to things a player must not see), no horse flag and nothing derived
from one - a horse is a player and wins like one (10.5). Certification
rounds are kept out, as they are kept out of the fairness statistics. The
same read returns the last twenty crash points on the host, which is the
first thing anyone who has played Aviator looks for.

On the page: `FloorFeed` prints **Recent Wins** as engraved rows on a console
of its own - the lobby shows every game, each game page shows its own - with
the prize in the ink the master gives it (gold for chips, blue for diamonds)
and your own wins in white. `CrashPointsStrip` prints the twenty points above
the curve, newest first, muted under 2x, silver to 10x, gold past it. Nothing
is drawn. `useGameFloor` reads on mount, every thirty seconds while the page
is open, and again the moment the player's own round lands, so a win is on
the floor before the toast has faded. It stops when they leave.

## The first real rounds

With the doors open, the test account played the first eight real rounds on
production: three spins, three drops, two Crash rounds. 800 diamonds in, 4.20
chips out - a 0.20 and a 0.50 off the wheel, two 1x drops, one auto cash-out
at 1.5x, one round crashed at 1.39x with nothing paid. Every pool minted
exactly its share (0.743 of intake on the wheel, 0.80 on the other two), every
invariant holds, and those eight rounds are what the floor shows.

## Caught on the way

- A fractional prize printed as a whole number: `chipsLabel` sent anything
  from one chip up through `compactChips`, which floors, so 1.50 chips read
  "1 Chips". A prize is exact when it is fractional (Dan, on 0.20 Chips:
  "ITS FINE"), compact when it is whole. The same rule now serves the wheel,
  Plinko, Crash and the floor.
- The floor's first render carried a broken avatar: `arena_avatar_url` is a
  Hub-relative path and needs the Hub origin. It goes through the felt's own
  helper now.

## Gates

`check-ui-text`, the three Title Case checks, `tsc`, the full vitest suite
(1,315 files, 18,210 tests). The migration was dry-run with a probe that
played rounds and read the floor inside the same rolled-back transaction
before it was applied, and its own self-check refuses a caller with no
account.
