# The hand rests before the next one, and the Rabbit Hunt button finally has a window

2026-09-05. Branch `feat/rabbit-hunt-window`.

Dan, verbatim: "GOT TO 1.75MS AND THIS SAME 1.75MS PAUSE SHOULD BE DONE ON ALL
HANDS UPON COMPLETION, GIVE USERS A CHANCE TO USE THE RABBIT HUNT. IT CURRENTLY
DOESN'T REALLY HAVE ENOUGH TIME TO CLICK AND USE. EVALUATE THAT AS WELL, HOW CAN
IT BE IMPROVED (THE TIMING AND AVAILABILITY OF WHEN THE BUTTON POPS UP). AND
ALSO IT NEEDS A DISABLE OR HIDE OPTION IN THE TABLE SETTINGS FOR USERS THAT
DON'T WANT IT POPPING UP."

## The evaluation he asked for, and the answer nobody had looked at

The Rabbit Hunt button was not short of time because its own guards were mean.
It had two, and both were generous:

- the SERVER keeps an offer purchasable for 90 seconds
  (`RABBIT_HUNT_OFFER_TTL_MS`);
- the CLIENT holds the button up for a 2-second minimum once it appears
  (`RABBIT_MIN_VISIBLE_MS`, Dan's own number from 2026-08-27).

Both were measuring a clock the player could not see. The button is RENDERED
behind `!tableState.isHandInProgress`, and the engine does not broadcast a
hand-free state until the entire completion hold has already elapsed:

```
setLoopPhase('post_hand_hold');
await sleep(resultDisplayMs);        // 4.5s on a fold, up to 7.4s on a showdown
broadcastCurrentState();             // <- only HERE does isHandInProgress go false
await sleep(boardClearMs(...));      // 500ms fold / 900ms showdown
// next hand
```

The offer arrives at SETTLEMENT, near the top of that hold. So the button was
live, and invisible, for four and a half to seven and a half seconds, and then
visible for whatever came after the broadcast: the board clear, and nothing
else. **Half a second on a fold.** The 2-second floor could never be reached,
and the 90-second TTL was describing a purchase window that had been over for
89 of those seconds.

A previous note in `TablePage.tsx` had seen the symptom and drawn the wrong
conclusion. It read: "the floor buys less than its full two seconds. That is the
safe trade and not an oversight ... Lengthening the window means making the
reveal hand-safe first, which is a change to `handleRabbitReveal`, not to this
gate." The gate was never the problem. The engine simply never left the player
any time on the correct side of it. That comment has been rewritten rather than
deleted, because the hazard it names is real and still holds.

## The fix: a beat of its own, after the board clear

`HAND_COMPLETION.RABBIT_HUNT_WINDOW_MS = 1750`, slept by the engine as a new
phase (`post_hand_rabbit_window`) AFTER the hand-free broadcast and after the
board clear. Visible window per hand:

| hand ends on | before | after  |
| ------------ | ------ | ------ |
| a fold       | 500ms  | 2250ms |
| a showdown   | 900ms  | 2650ms |

Both now exceed the 2-second floor, so that guard means what it says for the
first time.

**Two things it is deliberately NOT.**

It is not inside `handCompletionHoldMs`. That function has exactly one job, and
its header says so: be at least as long as the animations it is holding for.
Every number in it is derived from an animation length. This one is derived
from a human being - reaction time plus a tap - and folding it in would make the
hold's arithmetic stop meaning what the file claims it means. A test pins the
fold hold unchanged at sweep + push + muck + rest, and pins that it has NOT
grown by the window.

It is not conditional. A rest that happened only when a rabbit hunt was
purchasable would announce, from the table's rhythm alone, that the deck still
had cards in it - every seat would learn that the hand ended early. That is the
same reasoning as the rebuy pause under CLAUDE.md 10.5, where a bust that costs
the table no beat identifies the seat as a horse. A test asserts there is no
branch of any kind between the board clear and the sleep.

Placing it after the broadcast also solves the hazard the old note worried
about for free: a reveal freezes the client's snapshot for three seconds, which
is only dangerous while a hand is live. In this window there is no live hand for
the freeze to starve, so nothing had to be made hand-unsafe to buy the time.

## The all-in run-out gap: 1250 -> 1750

`ALL_IN_STREET_REVEAL_MS` had never been anything but a guess. The 2026-09-05
research into how other rooms pace a run-out turned up exactly one sourced
number in the entire industry - PokerStars' all-in pause, trialled at 2000ms,
dropped to 1000ms, settled at 1500ms - and Dan set ours a quarter of a second
past their landing point.

Every consequence is derived, not re-typed. The all-in card profile takes its
face-down HOLD from this constant, so the extra 500ms lands entirely on the
tension beat: the flip itself is untouched at 300ms, still inside the 400ms
ceiling the same research established. A test pins that the hold grew and the
flip did not.

Both mirrors of `handCompletionSpec.ts` are updated identically; the existing
byte-for-byte mirror test enforces it.

## The opt-out

`user_table_settings.rabbit_hunt_button`, default TRUE, with a row in
`TABLE_SETTINGS_META` so the switch appears in both places the settings panel
is mounted. Migration
`20260905172514_user_table_settings_gain_the_rabbit_hunt_button_toggle.sql`,
applied to production and declared in
`scripts/ci/schema-manifest.d/rabbit-hunt-window.json`.

Default true because the switch hides an offer the player already had: an
existing row that predates the column must behave exactly as it did yesterday,
and the column is backfilled rather than left NULL so the database and the
client agree without either depending on the other's fallback.

**It hides the button and nothing else.** It does not shorten the pause. The
pause is served by the engine to the whole table, so a per-player preference
that changed it would alter everybody else's pace - and, by making the pause
intermittent, leak exactly the information the unconditional rule above exists
to protect. A test asserts the engine and both spec mirrors have never heard of
the setting.

This is not a 10.6 animation toggle. 10.6 forbids a toggle that disables an
animation that is OWED; a player who declines to invoke a paid feature is never
owed its reveal, and the reveal itself, when bought, still plays in full.

## Still open, and deliberately not built

**The reveal freeze is still a blunt 3 seconds.** `handleRabbitReveal` stops the
client applying engine snapshots for 3000ms so the next hand's state cannot wipe
the ghost cards off the board. Click late in the window and part of that freeze
lands inside the next hand, which can cost the hero action time. The hazard is
unchanged by this work - the old 500ms window had it too - but the honest fix is
to paint the rabbit cards over a RETAINED copy of the finished board instead of
freezing the live snapshot pipeline, and that is a change to how TablePage
applies state. It is its own commit, with its own tests, and it is not a rider
on a pacing change.

## Verification

`tsc --noEmit` clean on both the app and the engine. Full vitest suite green,
including nine new pins in `tests/unit/rabbitHuntHasTimeToClick.test.ts` - the
two that matter were run against the pre-fix engine first and both failed, which
is what makes them worth keeping. `vite build` clean.
