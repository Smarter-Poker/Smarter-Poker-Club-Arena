# 2026-09-06 - Previous Hand build plan, Phase 7 of 7: accessibility, devices, performance

Plan: `docs/PREVIOUS-HAND-REPLAYER-BUILD-PLAN.md`. The last phase. Builds on
Phase 6 (`96d4065624`, live).

Six phases put the hand in front of the player. This one is about the players
who could not read it, the phone it does not fit, and the work it does that
nobody asked for.

## Every card says what it is

Every playing card on this platform is one component. Its alt text was:

```
alt={`${card.rank} Of ${SUIT_MAP[card.suit]}`}
```

That interpolates the rank **raw**, so a screen reader announced the ace of
spades as **"A Of spades"**, the ten of hearts as **"T Of hearts"**, the deuce
as **"2 Of clubs"**. On the felt, in the rundown, in the replayer, on a shared
hand - everywhere, because there is only the one renderer. A player who cannot
see the cards was being read the sprite's own field values.

**A face-down card was worse: it was silent.** `CardBack` carried no `alt`, no
`role`, no label at all. Every muck, every opponent's holding, every undealt
seat announced nothing - so a hand read as two cards SHORT rather than as two
cards you cannot see, which is a different hand.

`src/utils/cardWords.ts` is now the one place a card becomes a sentence, and
the alt text comes from it. There were already two private rank-word maps
drifting apart - `replayMotion.ts` said `2 -> 'Deuce'`, `TablePage.tsx` said
`2 -> 'Two'`, neither exported, both feeding player-facing labels.

**And one of them stays separate, deliberately.** `preflopHoleLabel` keeps its
`Deuce`, because "Pocket Deuces" is what a poker room says and "Pocket Twos"
is not. That is an idiom for naming a HOLDING; this names a CARD, and a card is
read "two of clubs". The words differ because the sentences differ, and the law
says so, so nobody unifies them and breaks the felt's own voice.

**Nothing is announced twice.** Two places were reading the same cards out
twice over:

- the broken-image fallback draws rank and suit glyphs beside an `<img>` that
  KEEPS its alt while hidden. Now `aria-hidden`.
- the board's region built its own sentence from the raw fields -
  `"Community Cards: A of s, T of h"` - and then every card inside it announced
  itself again. The region uses the helper now and the cards inside are hidden.

## The keyboard-only walk

**The replayer's tablist was half a tablist.** `role="tablist"`, two
`role="tab"` buttons, and none of what makes those roles true: both tabs
tabbable, neither naming its panel, neither panel naming its tab, and the arrow
keys dead. A screen reader announced "tab 1 of 2" and then could not move
between them. It is the full pattern now - one tabbable tab, arrows wrapping,
Home/End, and focus following selection, which is the half that makes a roving
tabindex usable at all.

**The container is a `tabIndex={0}` div** carrying the transport keys. An
unnamed focus stop announces nothing, so it says what its keys do - and only
while the Replay tab is showing, because its handler returns immediately on the
Rundown tab and a stop that does nothing is a lie.

**Two dialogs let Tab walk out of them.** The table's Previous Hand panel said
`role="dialog"` and `aria-modal="true"` and did neither: focus stayed wherever
it was, Tab went straight into the live table underneath, and closing it left
focus nowhere. A player driving it by keyboard was tabbing through the seats and
the action bar of a hand in progress, behind a panel that claimed to be modal.
The hand modal had focus in and focus back but nothing keeping Tab inside.

**`aria-modal` is a promise to a screen reader, not a mechanism** - the browser
walks the whole document regardless. Both trap Tab now, both recover focus that
has fallen outside (click any non-focusable part of a dialog and
`activeElement` becomes `<body>`, which is the common case, not an edge one),
and both still close on Escape.

## The 9-max felt at 375px, measured on the real page

The share page needs no login, so this was the LIVE felt at 375x812 with a real
8-handed PLO8 hand - not a mock, not a screenshot of a mock.

Four pairs of seats were overlapping:

|                                     |            |
| ----------------------------------- | ---------- |
| Player u49 cards x Player u50 plate | 27 x 32 px |
| Player u52 cards x Player u53 plate | 45 x 12 px |
| Player u54 plate x Player u55 cards | 45 x 12 px |
| Player u49 plate x Player u50 plate | 29 x 5 px  |

The middle two are what a player notices: **"CO 221.76" was cut in half** by the
seat above's cards. A stack you cannot read is the one number on the felt that
has to be right.

The seats sit round an ellipse, so the colliding pairs are DIAGONAL neighbours -
they overlap horizontally because they sit at different heights. Vertical room
separates them without shrinking a single card: `4 / 6.4` takes the felt from
419px to 536px and clears three of the four.

The fourth is the hero, bottom centre, whose card row reaches up into the
bottom-left seat's plate. **Shrinking never fixed it** - 27px of overlap became
7px at a 21px card, illegible and still overlapping. Moving the hero DOWN did,
at 36px, with nothing left hanging outside the felt.

Re-measured with both applied: **zero overlapping pairs, zero seats outside the
felt**, and the rundown at 375px has no horizontal overflow at all.

## Measure and trim

Timed against the 38-hand production corpus:

|                  |                     |
| ---------------- | ------------------- |
| model build      | 0.376 ms per hand   |
| search subject   | 0.0018 ms per hand  |
| search predicate | 0.00027 ms per hand |

The search costs nothing. The model is built ONCE by the service and reused, so
a page of 25 pays 9.4ms at fetch and nothing per render.

**What actually cost was the fade-in.** It armed a `setTimeout` for EVERY
loaded hand and each callback copied the whole visibility map. The delay is
`Math.min(i, 12) * 40`, so past the thirteenth card every timer fires at the
same 480ms - 487 timers in one tick at 500 hands, each a separate state update
copying a 500-key object. And it re-armed on every change to the id list: every
search keystroke, every chip, every Load More.

Only the first dozen are actually staggered, so only the first dozen get a
timer. The rest arrive in one update - which is what it looked like anyway,
because they were all landing together.

**"Virtualise the archive past 100 hands" is `content-visibility`**, and that is
a deliberate choice rather than a shortcut:

- these rows EXPAND. A card holding a full rundown is many times the height of a
  collapsed one, and a windowing list that guesses heights on a list whose rows
  change height is the version that jumps under the player's thumb mid-scroll.
  That is a worse bug than the one it fixes.
- the browser already knows what is on screen. `content-visibility: auto` lets
  it skip layout and paint for a card that is not, with no scroll maths of ours
  to get wrong, and `contain-intrinsic-size` keeps the scrollbar honest.
- where it is unsupported nothing breaks: every card renders, exactly as before.
- an EXPANDED card never defers - it is the one being read.

## Pins

`tests/a-card-says-what-it-is.law.test.ts` (a law, registered in
`docs/laws.d/`): the rank is spelled, a face-down card names itself, the one
renderer takes its alt from the one helper, nothing is announced twice, and the
poker room keeps "Deuce".

`tests/unit/theHandSurfacesTakeTheKeyboard.test.ts`: the tablist pattern, both
dialogs trapping and restoring focus, the felt geometry WITH the measurements
that produced it, and the archive's timer and deferral thresholds.

**Twelve of the sixteen fail against the shipped code.** A pin that passes
before the fix is not pinning anything.
