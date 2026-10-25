# Lightning horses read every hand (2026-10-24)

Dan: "HORSE READS FOR LIGHTNING GAMES NEED TO BE FIXED AND ADJUSTED AS WELL,
HORSES NEED TO MAKE REAL TIME READS, AND USE ANY AND ALL PLAYER DATA ON THE
VERY FIRST HAND EVERY SINGLE TIME THEY START A NEW HAND AT A NEW TABLE WITH
NEW PLAYERS."

## What was wrong (read from production and source, 2026-10-24)

1. **No Lightning hand was ever observed by the horse mind.** A physical
   table commits through `saveHandHistory`, which sends the accepted hand to
   the live horse lane (`observeCompletedHand`). A Lightning hand commits
   through `fn_lightning_settle_hand` and never made that call. Production was
   settling about 2.3 Lightning hands a second; none reached the in-memory
   mind. So VPIP/PFR, aggression, c-bet and 3-bet folds, showdown strength
   after big bets, the "who is hunting this horse" pair counters and the
   style-change fast window learned nothing from fast-fold play - the one
   format where every hand is a new table and the read is all a horse has.
   In the three Lightning games with no durable memory (fixed-limit hold'em,
   FLO8, short deck) a horse had no opponent read at all.
2. **Every Lightning shove read as passive.** The Lightning action record
   dropped the controller's `isFullRaise` flag that the physical engine
   carries (V12.3). Both learners - `HorseMind.observe` and the durable SQL
   increments - count an all-in as aggression only when that flag is true.
   Production, last hour: 115 Lightning all-ins, 0 flagged. A player jamming
   every hand looked like a nit.
3. **A new table size was a cold read.** The durable read is keyed by exact
   context (variant, mode, size). Lightning seats fill one at a time, so the
   same pool swings between short-handed and full; a player with hundreds of
   short-handed hands was unknown on their first six-max hand.

## What changed

- `server/src/lightning/LightningHorseObservation.ts` (new): builds the same
  observation the physical path builds - `table:hand` key,
  `table:hand:lease:observe` fence, committed hand id, accepted actions,
  showdown, V45 scope, and the actors' durable profiles read after the commit
  in the hand's own size bucket - and sends it to the lane. Never throws.
- `LightningHandHost.settle`: calls it the moment settlement commits, before
  the post-commit drain and before anyone is released, so the next hand any of
  these players is matched into already includes this one. Not awaited.
- `LightningHandHost` PLAYER_ACTION: carries `isFullRaise` and the
  controller's public action node (pot, current bet, every seat's street bet)
  exactly as `ServerTableEngineHandEvents` does, so `HorseMind.bandFor` and
  `initialPublicMoney` rebuild a Lightning player's range from the exact price
  they faced instead of the approximate replay.
- `HorseOpponentMemory.blendOpponentMemory` / `opponentMemoryDonors`: when the
  exact bucket has fewer than 12 effective hands, the other multiway bucket of
  the same variant and mode is added at weight 0.6 (rates kept, evidence
  shrunk, so the Bayesian gate needs a clearer deviation). Heads-up and the
  cash/tournament split stay isolated on purpose.
- `HorseMind.opponentRead` uses the blend; `snapshotDecisionReads` copies the
  donor context so the second look reads exactly what the first did.

## Pins

- `server/src/lightning/aLightningHandTeachesTheHorses.law.test.ts` (law;
  registered in `docs/laws.d/a-lightning-hand-teaches-the-horses.md`): all
  five cases fail on the previous host and pass now.
- `server/src/engine/HorseOpponentMemoryDonor.test.ts`: the first-six-max-hand
  and second-look cases fail on the previous `HorseMind` and pass now.

## Not changed

No migration, no money path, no settlement or seat write. The extra durable
read per Lightning hand is the same bounded, admission-controlled
`fn_horse_exploit_profiles_read` the physical path already makes once per
hand. Engine runtime change: activates in the daily 04:00 America/Chicago
window.
