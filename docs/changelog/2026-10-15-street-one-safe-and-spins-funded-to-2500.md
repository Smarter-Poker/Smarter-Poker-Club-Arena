# 2026-10-15 Street One Is Always Safe, And Spins Are Always Funded To 2,500

## Donkey Cross Street One

Dan: "STREET 1 IS ALWAYS SUPPOSED TO BE 100% SAFE, NEVER DIE ON STREET 1 EVER."

Contract 6 (2026-10-12) put the fair coin on every street, street one included, which undid the earlier rule that the first step of a bonus game never ruins it. Contract 7 (`20261015093545_donkey_cross_street_one_is_always_safe.sql`, `src/utils/roadCoin.ts`): street one is certain and pays 0.80B; street k+1 is contract 6's coin and contract 6's street-k prize, so booking after any street is still worth exactly 0.80B (proven in `tests/the-games-never-pay-more-than-they-take-in.law.test.ts`). Sealed contract-6 rounds keep verifying as they were dealt.

## Diamond Spins Funded To 2,500

Dan: "SPINS MUST ALWAYS BE FUNDED TO 2500 AND NEVER DISPLAY 'ONLY FUNDED TO 2,480'."

`max_funded_entry` was pinned by two exposure ALLOWANCES (configuration rows), not by money: Midway Union's Plinko allowance (1,522.73 chips) left 2,505 of room, so ordinary payout variance printed "Funded To 2,480", and the wheel's own allowance bound sat at 3,637. The host's real cover allowed 4.5 million. `20261015093549_diamond_spins_are_always_funded_to_twenty_five_hundred.sql` raises every wheel and bonus game allowance to at least 25,000 chips (ten worst-case 2,500-diamond promises at the live bridge rate) and a trigger holds that floor on every future write. Game tables still cap every payout and the host's real chip cover is still checked on every spin.
