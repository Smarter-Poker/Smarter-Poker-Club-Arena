# Horses play the Diamond Arena (2026-10-06)

## What Dan asked

> "CREATE THE SAME FUNCTIONALITY FOR THE HORSES INSIDE THE CLUB ARENA, TO PLAY IN
> THE DIAMOND ARENA. IF A HORSE IS BROKE OR HAS NO CHIPS THEY SHOULD BE PLAYING IN
> THE DIAMOND ARENA TO GET DIAMONDS ... ASSIGN ALL THE HORSES THAT WERE INSIDE OF
> DEEP STACK SOCIETY TO PLAY IN THE DIAMOND ARENA NOW."

And, later the same morning: let him know when horses are added and fully
integrated, and prove the engine fix first, before cash games start.

## What was measured first (production, read-only, 2026-10-06)

- The arena (`002c2d27-...`) has 17 plain NLH cash tables, one per stake from
  1/2 to 5,000/10,000 whole Diamonds, all empty. `cash_games_enabled` is
  false, `tournaments_enabled` true; the arena has never held a tournament.
- `atomic_table_buyin` already routes an arena table to
  `fn_poker_diamond_buyin`, which reserves the player's own `profiles.diamonds`
  and needs no club membership. The database side of a horse buy-in was
  therefore complete; nothing in the fleet ever asked it.
- The fleet dropped every Diamond table at the top of the cycle
  (`isChipFleetTable`), so no horse could ever be seated there.
- Deep Stack Society has 416 horse members and no open tables at all. Every
  seated horse is at Midway Union.
- At a Diamond table a busted horse was neither rebought (the horse recovery
  pass and the settlement rebuy both return for Diamonds) nor released (the
  human stand-up filtered horses out): it would hold a zero-stack chair forever.
- The session rotator read rolls from `club_members` only, so at a Diamond seat
  the roll was undefined and the bankroll cap on a reload was skipped.

## What changed

1. **Same cycle, same door.** Deep Stack Society horses are candidates for the
   arena's cash tables through the existing seeding walk, candidate filter,
   `sitVerdictFor` and `atomic_table_buyin`. The arena's tables join only the
   seeding walk and never `tables`, so no chip-floor planner (feeders,
   `fn_cash_game_ensure`, host caps, band supply, the seat-call answerer) can
   plan, open or close one.
2. **Latent while closed.** The cycle reads `ca_arena_settings` once. Unless
   `cash_games_enabled` is exactly true, no arena table enters the cycle and
   nothing else is read. The fleet never writes the switch.
3. **The wallet is the horse's own Diamonds.** For each Deep Stack horse the
   arena becomes one more membership keyed `${arena}:${horse}`, with
   `profiles.diamonds` as the roll. The read fails closed: an incomplete read
   empties the arena for that cycle. Nothing funds a horse.
4. **Whole Diamonds, idempotent.** The buy-in is floored to whole Diamonds
   (none under the table minimum). An arena seat sends a fresh
   `p_idempotency_key` per attempt, which the arena door requires; chip seats
   send exactly what they did.
5. **Stake by roll, not by chip band.** Merit bands are chip blinds and read
   every arena table as "high", so at the arena the bankroll gate (`canSit` on
   the table's reference buy-in, in Diamonds) decides the stake. The horse's
   Deep Stack tag still decides cash-or-events and variant.
6. **Separate exposure.** Diamond seats count against a Diamond exposure map,
   measured against the Diamond roll (`exposureFor`), never summed with chips.
   An arena seat does not make a horse "represent" a club for the
   one-club-at-a-time rule.
7. **Refusals by name.** `diamond_cash_not_open`, `insufficient_settled_diamonds`
   and the arena's already-seated message are counted (`diamond_closed`,
   `no_diamonds`, `already_seated`) and not reported as errors;
   `invalid_diamond_cash_purchase` stays reported, because it would be a defect.
8. **A busted horse at a Diamond table is released like a person**
   (`standUpBustedCashPlayers`): same grace, same `releaseBustedSeat` door.
9. **The rotator reads a Diamond seat's roll** from `profiles.diamonds`, and a
   reload whose roll could not be read is now refused, as the file's own note
   always said it was.

## What this does not do yet

- Cash games stay closed. Dan wants the engine fix proven before they open.
- Diamond Spins at Deep Stack Society refuses every spin today (all four of the
  club's bonus games are switched off), and no wheel door accepts the engine
  acting for a horse. The "broke horse spins Diamonds for chips" loop is a
  separate phase.
- The arena has no tournaments; Diamond tournament play for horses is a
  separate phase.

## Tests

- `server/src/services/horsesPlayTheDiamondArena.law.test.ts` (law, registered
  in `docs/laws.d/horses-play-the-diamond-arena.md`).
- `server/src/engine/aBustedHorseAtADiamondTableIsReleased.test.ts`
  (behavioural; fails against the old filter).
- The 116 existing horse, Stable Hand, rotator and Diamond suites pass
  unchanged (2,493 tests).
