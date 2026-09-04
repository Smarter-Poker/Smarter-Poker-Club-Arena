# 2026-09-04 — The templated rules become visible, and the VPIP window is ten hands

Operation Table Stakes, Gate 5 material brought forward. Dan, three
messages, verbatim:

1. "IF THE GAME IS CLASSIC, ACTION OR MADNESS, IT MUST SAY IT ON THE TABLE
   UNDER THE BLINDS."
2. "ANTES OR VPIPS ARE (NOT) DISPLAYING OR CALCULATING IN ANY GAME." "BOMB
   POTS ALSO ARE NOT GOING OFF WHEN THEY ARE SUPPOSED TO."
3. "VPIP SHOULD BE DISPLAYED AS A REALTIME PERCENTAGE TRACKER TO THE LEFT OF
   THE HERO (ONLY VISIBLE FOR THE USER). AND IF ANYONE FALLS UNDER THE SET
   THRESHOLD FOR THE GAME AFTER 10 HANDS, OR ANYTIME AFTER THE 10 HANDS, THEY
   GET BOOTED."

## What production was actually doing (read from rows, 22:5x-23:1x UTC)

Before changing anything I read the board, because "not calculating" and
"not going off" are claims about the engine and the engine keeps records.

| Rule          | Evidence                                                                                                                                                                                                                                                                                    | Verdict                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular antes | 692 of 714 Action hands and 437 of 619 Madness hands since 21:43 UTC carry `ante` postings in `hand_history.actions`; the pot includes them.                                                                                                                                                | **Collected every hand. Never shown.** No snapshot field carried it, the table page never selected it, and the one modal that can print an ante was never handed one.                 |
| Bomb pots     | 22 bomb hands on Action tables at a 15-minute cadence (e.g. PLO5 0.10/0.25: 22:17, 22:33, 22:48, 23:03); 182 on Madness (every orbit, ~every third hand two- and three-handed). The felt shows "BOMB POT IN 4:36".                                                                          | **Firing as designed.** The scheduler, its persistence across the :55 restart, and the felt countdown all check out. Nothing in this PR changes bomb pots.                            |
| VPIP floor    | Every Action / Madness table: `nit_game = true`, `maintain_percent_min` = the template floor (30-40 / 60-70), `fn_nit_evictions` at every hand boundary, VPIP on file in `ca_hand_facts` for every seat (horses included since the 2026-08-27 law). Nobody under the floor over the window. | **Calculating and armed.** Two real defects: the window was 40 / 30 hands (OPORD 1.3 section 11.2) where Dan wants ten, and no player could see the figure they were being judged on. |

So of the three things Dan named, one was invisible money, one was working,
and one was working on the wrong window with no display. All three now say
what they are doing.

## 1. The felt says Classic / Action / Madness, and prints the ante

`TablePage.tsx` selects `cluster_id` with the table row and, for a table of a
templated game, reads `cash_games.template_name` (readable by any signed-in
member; the read is fire-and-forget and the felt never waits on it). The
masthead's blinds line gains `· Ante 1` when the engine reports an ante, and a
new line under it carries the style in gold: `ACTION`.

The engine publishes the ante with every snapshot (`ante`, chips per posting;
`ante_mode`, `per_player` or `big_blind`), on all three publish paths. The
client maps it (`mapEngineSnapshot.ante` / `anteMode`) and reads 0 / null off
an older engine.

## 2. The window is ten hands, everywhere a window is written

Migration `20260904231353_the_ten_hand_vpip_window_and_the_status_readers`,
one transaction, applied to production:

- `fn_cash_template_defaults`: `vpip_window` = 10 for every template.
- Every templated game's `ruleset_snapshot.vpip_window` = 10, and every
  cluster table's `maintain_hands` = 10 (the column `fn_nit_check` reads, so
  it takes effect at the next hand boundary with no engine change).
- Asserts all three at the end, so it aborts if any writer missed a row.

The rule already checks at every hand boundary after the window, which is
"anytime after the 10 hands". Horses are judged identically (the horse-only
predicate left `fn_nit_evictions` on 2026-08-27; I checked the live
definition, it is gone).

**Measured before applying:** at a ten-hand window, 18 of the 56 seats on
templated tables were under their floor at that moment, all horses, 15 on
Madness tables whose floor is 60-70% against a fleet tuned to 19-32% VPIP
(`HorseSelfTuner`). They stand up at their next hand boundary
(`atomicCashout` to the club wallet, reason `nit_game_vpip`, no chips lost)
and the fleet reseeds. Left there, a Madness table would churn every ten
hands - which is why the next section ships in the same PR.

## 3. A horse plays to the floor

A horse obeys the VPIP floor identically to a human (CLAUDE.md 10.5; OPORD 1.4
section 2.2). Obeying a floor means staying above it, not being stood up every
ten hands. So the brain now knows the floor and its own judged figure:

- `fn_nit_status(table)` (service_role only) returns every seat's hands, VPIP,
  floor, window and `fn_nit_check`'s verdict, from the same query the eviction
  reads. The engine reads it beside the eviction at every hand boundary on a
  floored table (`ServerTableEngineBase.nitStatus`) and hands the brain
  `vpipFloor` and `ownVpip` with the rest of the game state.
- `HorseLogic.vpipFloorMul` scales preflop tightness (`<1` = looser), last, so
  open, call, defend and 3-bet ranges widen together. Target = floor + 10
  points, capped at 95%. Under three hands it is a prior (the fleet's base
  width over the target: 0.7 for an Action hold'em table, 0.35 for Madness
  PLO). From three hands it closes on the judged figure: under target by g
  points loosens by 1.5g, floored at 0.35; at or over target the multiplier is
  1 and the horse's own style resumes. It never tightens.

Ten unit tests pin the arithmetic and the wiring
(`server/src/engine/HorseVpipFloor.test.ts`).

## 4. The hero's tracker, to the left of the hero

`HeroVpipTracker` sits at the hero seat's own point and is pushed left of the
pod by half its width per breakpoint (the `SEAT_SIZE_RUNGS` in
`tableGeometry`), so it rides with the seat and never overlaps the avatar.
It prints the figure large with `VPIP` above and, under it, `Min 30% · 7/10
Hands` while the window is filling, `Min 30% · 14 Hands` after, or `N Hands`
on a table with no floor. The figure's colour is its standing: blue while
sampling, green above the floor with room, amber within five points, red
under after the window (the box glows red too).

**It is the judged number.** `fn_cash_vpip_status(table)` is keyed on
`auth.uid()` and reads `ca_hand_facts` for this table and this sitting exactly
as `fn_nit_check` does - not the client's own session count, which starts when
the tab opened and counts what the tab saw. A tracker that disagrees with the
rule it warns about is worse than none. Keyed on the caller, it is private at
the database, which is what "only visible for the user" means.

Refreshed after every hand (1.5 s after the hand number moves, so the fact row
has landed), on sit, and on a 45 s backstop. Nothing renders for a spectator
or on a tournament. Ten tests in
`tests/unit/heroVpipTrackerAndFeltStyle.test.tsx`.

## Open, and Dan's to decide: what "One Small Blind" / "One Big Blind" means

The create flow labels the regular ante "One Small Blind" / "One Big Blind";
the game card says "1 SB Ante" / "1 BB Ante". The cluster writer maps that to
`ante_enabled = true, ante = sb | bb` and never sets `big_blind_ante_enabled`,
so the engine's traditional branch runs: **every seat posts the full amount,
every hand.** Read from `hand_history` tonight: on NLH 1/2 Madness each of
three players posted 2.00 (three big blinds of dead money a hand); on PLO4
0.25/0.50 Action each posted 0.25. The engine's own `AnteMath` doctrine says
nobody charges a full big blind per seat and that `ante >= bigBlind` means
the structure authored a TOTAL - that is the big-blind-ante mechanic
(`big_blind_ante_enabled`), where the big blind posts one ante of that size
for the whole table.

Two readings, costed per hand at a six-handed 1/2 game:

| Reading                                                                                       | Action (`sb`)          | Madness (`bb`)          |
| --------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- |
| Per seat (today)                                                                              | 6 x 1 = 6 chips (3 bb) | 6 x 2 = 12 chips (6 bb) |
| One ante for the table, posted by the BB (the label's plain reading, and the modern standard) | 1 chip (0.5 bb)        | 2 chips (1 bb)          |

This is the price of the game going forward, which section 10.9 leaves to
Dan. I have not changed it. My recommendation is the second reading: it is
what the labels say, it is what `AnteMath` was written to enforce, and 3-6 big
blinds of dead money every hand is a structure no card room runs. The change
is one line in `fn_cash_cluster_open_table` (`big_blind_ante_enabled = v_ante
<> 'none'`) plus the same on the tables already open; the engine needs no
change.

## Still true after this PR

- The eviction is a between-hands database query, as designed
  (`nitGame.ts`); with the window at ten it has a ten-hand sample to judge.
- Bomb pots were never broken. If Dan saw one not fire, the place to look is
  `bomb_pot_min_players` (2) against seats dealt in, or the :55 restart's
  five minutes, both of which the felt countdown reports.
