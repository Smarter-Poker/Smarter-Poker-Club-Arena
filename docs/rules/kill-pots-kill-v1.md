# Kill And Half-Kill Pots: rule manifest `kill-v1` (integration owner decisions, 2026-09-22)

Status: Proposed house rule for implementation. Sources: PokerBROS "PokerBROS goes in for the kill" (2021-03-17,
re-read 2026-09-22: available for Fixed Limit Hold'em and Omaha Hi and Hi-Lo) and the Cardplayer / Robert's Rules
kill-pot chapter ("the killer acts in proper turn (after the person on the immediate right)"; full kill doubles
the big blind and limits; half kill is 1.5x). Where the two differ, the decision below is recorded as ours.

## Scope

- Cash tables only. Variants: `flh` (Fixed-Limit Hold'em) and `flo8` (Fixed-Limit Omaha Hi-Lo). Nothing else:
  no tournaments, no Stud/Razz/Badugi/draw, no OFC, no mixed-game rotation.
- Chips (cents) and Diamonds (whole units) both allowed, subject to the exactness rule.
- Incompatible with bomb pots on the same table (configuration is refused with a precise message). Straddles are
  already refused on fixed-limit tables. Run It Twice and Insurance/EV Cashout stay available.

## Configuration (per table, frozen per hand)

- `kill_mode`: `off` (default) | `half` | `full`. Multiplier m: full = 2/1, half = 3/2. Exact rational arithmetic.
- `kill_threshold_bb`: one of 8, 10, 12, 15 (default 10), in BASE big blinds.
- Rule version string: `kill-v1`.
- Exactness: the base big blind in minor units (cents for chips, units for Diamonds) times m must be an integer.
  For half kill that means the base big blind in minor units is even. Otherwise the configuration is refused.
- Settings changes apply at the next hand boundary. A kill already scheduled keeps the mode, multiplier and
  threshold frozen into its trigger record.

## Engine stake representation (existing)

- Base small bet = `big_blind`; base big bet = 2 x `big_blind`; ordinary small and big blinds are the table's
  configured `small_blind` / `big_blind` and never change for a kill.

## Trigger (evaluated once, after the hand's authoritative settlement)

- The hand is not a bomb hand, the table is in `half` or `full` mode, and exactly ONE player received every award
  of the hand: every pot (main and side), both halves of every hi-lo pot (a pot with no qualifying low is wholly
  won by its high winner), and every board/run (Run It Twice). Otherwise no kill (split, chop, different side-pot
  winners, different run winners).
- The contested total is the sum of pot amounts after uncalled bets are returned, BEFORE rake, BBJ drop or any
  other deduction. It must be >= `kill_threshold_bb` x base big blind.
- Then the NEXT hand is a kill hand and the scooper is the killer. The trigger is keyed by the triggering hand id,
  so a duplicate settlement event never schedules a second kill.
- A kill hand can trigger the next kill (chained). The threshold stays measured in BASE big blinds. Limits never
  escalate beyond the configured multiplier.

## The kill hand

- Effective limits: small bet = m x base big blind; big bet = 2 x m x base big blind. Ordinary blinds unchanged.
- Kill blind: m x base big blind, posted LIVE by the killer before cards. It is the preflop bet level:
  currentBet = max(big blind, kill blind). It counts as the first wager of the preflop cap (like the big blind at
  base limits). The existing 4-wager cap and incomplete all-in reopening rules apply to the effective increments.
- Killer already in the small blind or big blind: posts ONLY the kill blind in place of that blind (one live
  contribution). The other blind posts normally.
- Action order: ordinary clockwise order (first preflop actor left of the big blind; heads-up standard dealer
  rules). The killer acts in proper turn and, like a live blind, keeps the option when the pot is unraised.
- Short killer: a killer whose stack is below the kill blind posts all-in for the stack. The preflop bet level
  stays the full kill blind; others call the full amount; side pots apply; the hand stays at kill limits.
  No chips are manufactured.
- Killer not dealt into the next hand (left, sitting out, waiting for the big blind, moved, not in hand for any
  reason): the kill is cancelled, the next hand plays at base limits, and the cancellation is recorded. No
  obligation, fee, fine or cash-out restriction carries forward.

## Accounting (unchanged contracts)

- `hand_history.small_blind` / `big_blind` stay the BASE blinds (the BBJ commit check requires this).
- Rake schedule and rake cap, BBJ fee (base big blind x feeBB), BBJ minimum and tier, stake bands and reporting
  buckets all use BASE stakes. No additional rake, no raised caps, no changed buy-in minimums.
- The kill blind is a forced live contribution and counts in weighted contributed rake exactly like every other
  contribution (the approved rule counts all contributions; there is no forced/voluntary split to apply).
- Hand history records a `kill_pot` object: on a kill hand the mode, multiplier as a fraction, base big blind,
  effective small/big bet, kill blind amount, killer user id and seat, the killer's blind slot (none/sb/bb),
  trigger hand id, chained flag and rule version; on a triggering hand the next-hand kill (killer, contested total,
  threshold, scoop evidence); on a cancelled kill the cancellation reason.

## Recovery

- The pending kill is persisted atomically with the triggering hand's hand-history row and restored on engine
  start from the table's last settled hand (the `restoreButtonFromHistory` pattern). An in-flight kill hand that
  is abandoned by crash recovery leaves the kill pending, so the re-dealt hand is still the kill hand.
- A hand that already started keeps its frozen effective state even if the owner changes table settings.

## Horses

- Identical treatment (CLAUDE.md 10.5): horses trigger, post and play kill hands under the same rules; the horse
  policy reads the hand's effective fixed bet size.

## Availability gate

- The engine only honours kill configuration when the table has it; the database only accepts `kill_mode <> 'off'`
  while capability `cash.fixed_limit.kill_pots` is at readiness `deployed` or higher. The client only offers the
  control under the same readiness. Nothing is advertised or sold before the engine that enforces it is live.
