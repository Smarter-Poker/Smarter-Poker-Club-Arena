# Diamond Phase 9, Second Piece: A Mystery Chest Holds Whole Diamonds

Status: mystery bounties are built in Diamonds, behind the switch. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet. With the first piece, every bounty format the chip estate deals - knockout, progressive, mystery - now runs in Diamonds. Satellites, spins, guarantees and promotional entries are the later Phase 9 pieces.

## The Database

Migration `a_diamond_mystery_chest_holds_whole_diamonds` (applied as `20260914113514`; stored text byte-identical to the repo file, md5 `2de485aaa27f4b5ec2d1a27cda63632f`):

- `fn_mystery_bounty_seed` floors the mystery half of the pool to the event's unit and refuses any chest that is not a whole number of units (`chest_not_on_unit`).
- `fn_mystery_bounty_reserve` splits a chest between several claimants in whole units, the remainder to the first claimant by user id; at the chip unit the arithmetic is byte for byte what it was.
- `fn_bounty_obligation_has_complete_marker` - the evidence that a knockout obligation was settled exactly as its claimants deserve - expects the split at the event's unit: a mystery chest as above, a regular or PKO head in unit-floored equal shares with the remainder to the last claimant, a PKO cash half floored to the unit (which is what `fn_collect_bounty` pays). Without this every Diamond knockout obligation with more than one claimant, and every Diamond mystery award, would have stayed pending and the event could not have finished.
- `fn_mystery_bounty_settle` reads "bounty paid" from the Diamond ledger for a Diamond event.
- The creation door admits `mystery_bounty` and stamps the activation mode, value, profile, top percentage and pool split under the chip configuration door's rules (that door consults a club owner the arena does not have); a mystery range on a non-mystery format is refused; the advertised range is the chip multipliers on the flat bounty, in whole Diamonds.

Every chip edit is an asserted substitution with the live md5 pinned and the reverse substitution proved; the marker and the creation door are pinned and redefined with the same signature. No price is invented.

## The Engine

- `buildInventoryAtUnit` builds the chest ladder at the tournament's unit (the same ladder in Diamonds, scaled back to cents); at a chip unit it is the cent-exact builder, by construction.
- `TournamentManagerBase.maybeActivateMysteryBounty` reads the unit beside the tournament row and passes it to both pool computations and the inventory; a manager that could not read its club does not seed (reported as `Tournament.mystery_bounty_unit_unknown`) rather than seed at a guessed cent the database would refuse. The named admission `UNIT_CENTS_ASSET_NOT_READ` leaves the seed path; it stays where a place is priced without a club (`placeLadderUnitCents`), which the elimination tests already pin.
- Tests: `aDiamondMysteryChestHoldsWholeDiamonds.test.ts` (the ladder at both units, the refusals, the manager's two sites), `MysteryActivationCutoff.test.ts` (a Diamond seed in whole Diamonds; no seed at an unread unit).

## The Rehearsal

One rolled-back transaction through the real doors, before the apply: a Diamond mystery event (buy-in 110 = 99 + 11, bounty 40, activation at four players, classic profile, 50/50 split; a mystery range on a plain event refused by name); five entries (pool 200, prize 295, fee 55); the launch; a pre-activation knockout paying the flat 40 from the regular half; the seed refusing three chests off the unit and accepting three on it (20 + 30 + 50 = the 100-Diamond mystery half); a three-way mystery knockout split 8 + 6 + 6 in whole Diamonds, its obligation settled with the marker complete; two more chests (30, 50) to the same collector; the terminal paying the place (295) from the prize bank, the remainder of the bounty bank (60) to the champion and the fee (55) to the house, every bank, chest, award and custody row closed, the identity unmoved.

## What Is Still Not Here

- The mystery reveal, chest and celebration surfaces format cents with the chip formatter (`MysteryBountyPanel.tsx`, `MysteryBountyCelebration.tsx`, `MysteryBountyService.ts`, `RewardsTab.tsx`, `TournamentRankingCard.tsx`); display only, unreachable while the switch is off, listed for the client pass before the switch opens.
- Satellites, spins and their reserve, guarantees and promotional entries, the fee destinations for those formats, and the conservation tests across them: later Phase 9 pieces.

Law: a-diamond-mystery-chest-holds-whole-diamonds.
