# Omaha straights are checked against the flush board (2026-09-13)

Found by the daily horse audit analysis for 2026-09-12.

## What was wrong

`detectLeaks` in `server/src/services/HorseHandReview.ts` has two nut-discipline
blocks: one for Omaha, one for hold em. The hold em block asks three questions
about a made straight, in this order:

1. is a flush possible on this board -> `straight_into_flush_stackoff`
2. is somebody holding a bigger straight -> `nonnut_straight_stackoff`
3. otherwise nothing

The Omaha block asked only question 2. So a horse holding the **nut straight**
that stacked off into a three-flush board produced **no tag at all**:
`straightIsNut` was true, and nothing else looked at the board.

The question matters more in Omaha than anywhere else. With four, five or six
hole cards in play and three of a suit showing, somebody usually has the flush.

## The hand that found it

A plo6 cash hand on 2026-09-12 lost **385.2bb** with an empty `leak_tags` array:

```
hole   3h 6h 4s 8h 9d 6s      (6h+8h play the 4-5-6-7-8 straight)
board  5s 3d 7c 4d Jd         (three diamonds)
```

8-high is the best straight the board allows, so `straightIsNut` was true and
the only Omaha straight branch stayed silent. It is now the first case in
`HorseHandReview.test.ts`, and it fails without this change.

## Size of the blind spot

Seven days to 2026-09-12, Omaha showdown losses of 20bb or more on a board with
three or more of one suit:

| measure | hands |
| --- | --- |
| big Omaha losses, 5-card board | 40,837 |
| of those, on a three-flush board | 17,190 |
| of those, carrying none of the four nut-discipline tags | 10,951 (-487,675bb) |

Not every untagged hand is a straight. The straight subset was invisible.

## What changed

- `OmahaNutStatus` gains `flushPossible`, computed for every category rather
  than only in the branch that reads it - a field named `flushPossible` that is
  only true sometimes is a field that lies. Three or more of a suit on the
  board is the threshold, because Omaha plays exactly two hole cards.
- The Omaha branch asks `flushPossible` before `straightIsNut`, mirroring the
  hold em order.
- The `HorseDataLedger` entry for the tag now says where it fires and that it
  is measurement-only in Omaha.

## Measurement only, on purpose

The tag name is the existing hold em one, so the vocabulary does not grow, and
it is deliberately **not** added to `PLO_STACKOFF_TAGS`. Wiring it into the V20
pressure cap or the self-tuner's stackoff gate would change how horses play,
and that is a strategy change which needs a league matchup behind it. This
change makes the hand visible in the review panel and the daily audit; it
changes no horse's decision.

## Verification

`npx tsc --noEmit` exits 0. 83 test files / 1,044 tests pass - the full set that
touches `HorseEval`, `omahaNutStatus`, `HorseHandReview` and `HorseDataLedger`,
including `EveryTagHasAConsumer.law.test.ts` and
`EveryLeakTagHasADenominator.law.test.ts`. The first new test fails without the
source change and passes with it.
