# 2026-09-21: the bonus game entry flow is the player's, step by step (R1, R6, R9, R20)

Owner ruling 2026-09-21 (Dan's Diamond Spins change list), client side of the
bonus games. Workstream C3. Server counterpart: D2 restores `p_denom` on
`fn_wheel_bonus_start`; wheel side: C1 adds the Play Game button and
`pending_awards`.

## Behaviour

**R1, games can never auto start.** `BonusCompletion` no longer leaves for the
wheel after five seconds. It is a console with `Back To The Wheel` and, when
the wheel reports another won game waiting (`pending_awards` from
`fn_wheel_state_v2`, read once; absence or a failed read simply offers
nothing), `Play Next Bonus Game`, which opens that game with its award id.
Nothing else closes it: no timer, no overlay tap, no Escape. The same holds
for the Double Your Diamonds offer, which now closes only on one of its two
choices. Every timer left in the game pages was audited: the 1 s display
cooldowns, the Crash settle poll of an OPEN round, the scene frame loops and
the 1400 ms pop-open gates on the popups stay; the Crash auto play runner is
the player's own Run 5/10/25/50 with an explicit Start and is refused for a
wheel award; nothing starts a round or navigates on a timeout.

**R9, the sequence after Play Game.** Screen one is `Double Your Diamonds`
(`DoubleDownOffer`), a full step with `Add The Diamonds` / `Play Without`.
Screen two is the game's setup: for Plinko the drop selector, for the others
the Start plate. The step is derived, never timed: `bonusEntryStep(budget,
offerAnswered)` is `offer` for an award whose offer has not been answered and
`setup` once it has. The answer is remembered per award id in session storage
(`useBonusBudget` now returns `[budget, setBudget, offer]`), so a refresh lands
on the same step; a different award asks again, and an answer or drop value
saved for an earlier award is never carried into a new one (`awardBudget`
scopes the preference to its award; `useEarnedBonus` quotes a new award
without the old addition). A round already started is resumed by the page
exactly as before (Crash adopts its open round, the Choice games resume, a
redeemed Plinko award shows its receipt). While the step is `offer`, the
primary plate reads `Answer The Offer First` and is disabled.

**R6, the player chooses the Plinko drop.** The per-drop selector removed in
#4958 is back, on the console's own control styling, as screen two. It offers
the values from `PLINKO_DIAMONDS_PER_DROP` (1, 2, 4, 5, 10, 20, 25, 50, 100,
250, 500) that divide the stake exactly into 1 to 100 drops, prints the drop
count beside each, and pre-selects nothing: `denomination` is `null` until the
player chooses, the Per Drop and Drops bays read `Choose`, and `Drop Diamonds`
is disabled. The stake is the funded entry plus the addition when doubled; a
saved value that no longer fits the stake is cleared, never re-derived. The
receipt validators accept the chosen count: drops x value = stake, with 1 to
100 drops for a receipt sealed under the current rule (`payout_version`
present) and the dealt count for older receipts. `DiamondBonusService.start`
sends the chosen value as `p_denom`.

**Multi-drop play.** The tap on `Drop Diamonds` starts the game and releases
the first diamond. Every further ball is the player's own release: `Drop N Of
M` releases the next, `Drop All` releases the rest, and they come down at the
board's own cadence. `PlinkoBoard` schedules a ball at the moment it is
released rather than back-dating it to the batch start (a back-dated ball
landed without ever being seen). The chips are booked by the server at start,
as before; the receipt popup waits for the last landing and then for a tap.

**R20, Crash.** `DiamondCrashPage` no longer calls `setState` every animation
frame. The curve's frame loop is the one clock: each drawn frame hands the
multiplier to the page through `onTick`, which writes the readout's text nodes
directly and stores the figure in a ref, and prints the same number into the
hero. React re-renders on phase changes and once when the figure reaches the
cash-out floor (`Book The Win` opens). The clicked-multiplier contract is
exact: a tap sends the figure the last frame printed; while the request is
pending the page hands that figure back to the hero to hold. The loop is
cancelled while the tab is hidden and resumed when it is shown.

## Cause

`BonusCompletion.tsx:20-22` returned to the wheel by timer, where the idle
countdown then spun. `BonusSetup.tsx:180-191` opened the offer inside the
setup with no persisted step. `bonusGameBudget.ts:4-11` fixed ten drops of a
tenth (`defaultBonusBudget` denomination 10). `DiamondCrashPage.tsx:180-195`
re-rendered the page per frame.

## Proof

Vitest, all green: `tests/components/BonusCompletion.test.tsx` (stays two
minutes idle; Back To The Wheel; Play Next Bonus Game; tolerates a missing
list), `BonusDoubleDown.test.tsx` (step machine; two minutes idle on the
offer; remembered per award), `DiamondPlinkoAwardEntry.test.tsx` (offer ->
selector -> Drop Diamonds; nothing pre-selected; per-ball release and Drop
All; two minutes idle on each screen starts nothing; remembered across a
remount; asks again for another award), `DiamondCrashLifecycle.test.tsx`
(readout written without a render, the printed figure is the booked figure,
frozen while pending; Book The Win opens on the floor by one state change),
`CrashCurvePresentation.test.tsx` (hero and `onTick` agree per frame; freeze;
hidden pause), `PlinkoBoardPresentation.test.tsx` (a later release falls from
the top), `DiamondChoiceQuotes.test.tsx`, `EarnedBonusEntry.test.tsx`,
`DiamondGameControls.test.tsx`, `tests/unit/bonusGameBudget.test.ts`,
`diamondBonusReceipts.test.ts`, `wheelEarnedPostgresContract.test.ts`, and the
law `tests/the-games-never-pay-more-than-they-take-in.law.test.ts`, whose
ten-drop pin moved to the choice contract (owner ruling 2026-09-21, R6; the
registry entry in `docs/laws.d/` is amended).
