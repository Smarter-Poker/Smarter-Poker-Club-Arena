# Crash never ends before 1.25x, averages 2.9x and can fly to 20x (contract 5)

## What Dan asked for, in order

1. "CRASH ALWAYS CRASHES TOO SOON. THE GAME IS DESIGNED TO GO TO 20X MAX. THE GAME SHOULD NEVER CRASH BEFORE 1.25X AND NEEDS TO LAST A LITTLE LONGER ON AVERAGE."
2. "CRASH CAN BE A 5% HOUSE EDGE GAME. MAKE IT BETTER OVERALL FOR THE PLAYERS."
3. "BUT CRASH NEEDS TO BE ABLE TO GO AS HIGH AS 20X. MAKE SURE THAT PLAYERS ARE AWARE THAT THE 'AVERAGE CRASH' IS BETWEEN 2.4 -3.0X AND IF THEY 'BOOK THE WIN' OR STOP BEFORE IT CRASHES, IT SHOULD SHOW HOW FAR 'IT WOULD OF GONE'."
4. "CRASH CAN GO NEGATIVE, IT CAN PAY OUT UP TO 120% SINCE THE OTHER ARE ALREADY SUPER PROFITABLE."

## The contract (new rounds only, payout_version 5)

- The crash point is X = max(1.25, L + (R - L) / u), u = (roll + 1) / 2^48, where L is the round's loss minimum over its stake exactly as `fn_diamond_bonus_floor` gives it (unchanged: half the stake, or what a Super player paid).
- Cash out, by hand and on auto, opens at 1.26x. Every flight is capped at exactly 20x.
- R, the return at every cash-out target, is chosen PER ROUND so the 20x-capped average crash 1.25 + (R - L) ln((20 - L)/(1.25 - L)) is 2.9x, clamped to 0.95 <= R <= 1.20: R = L + 1.65 / ln((20 - L)/(1.25 - L)), in millionths rounded down (`fn_crash_return_ppm_v5`, forty decimal places in numeric). It is derived from what the round already seals (its stake and minimum), so verification is reproducible and nothing new is stored. The browser mirror (`crashReturnPpmV5`) computes the same logarithm in BigInt fixed point at fifty places and agrees with PostgreSQL on all 3,634 stake fractions checked.
- The clock is slower: k 0.10 -> 0.08 (1.25x at 2.8 s, 2x at 8.7 s, 20x at 37.4 s).
- Rounds sealed under contract 4 keep 1.10x / 1.11x / 0.80 and verify exactly as before.

## The new odds

|                                          | Standard round (L = 1/2) | Super with the add-on (L = 2/3) |
| ---------------------------------------- | ------------------------ | ------------------------------- |
| Return at every target                   | 1.006430                 | 1.137983                        |
| Rounds that end at 1.25x                 | 33.4%                    | 20.6%                           |
| Middle round (median)                    | 1.51x                    | 1.60x                           |
| Average crash (exact, sealed hundredths) | 2.8968x, shown as 2.9x   | 2.8961x, shown as 2.9x          |
| Rounds that reach 20x                    | 2.6%                     | 2.4%                            |

Under contract 4 a standard round averaged 2.14x and about half ended at the floor. The smallest odd entry rounds its floor up to 13/25 and returns 1.022420; a floor so high it would need more than 1.20 (only reachable on a tiny stake outside the award range) is clamped at 1.20 and averages 2.78x.

## Proofs

- Every hundredth from 1.26x to 20x is worth at most R of the stake and within one roll's grain of it, in integers, on every award stake kind (law item 8c, the migration's own readback, and `tests/sql/diamond-crash-contract-five.sql`).
- No stake an award can be played at returns above 1.20 or below 0.95.
- 4,000 contract-5 points PostgreSQL 17 sealed for 1,000 production rolls match the browser exactly.

## Money

- Crash paying back more than its stake is Dan's ruling 4; the games law now carries it for Crash only, quoting him, and every other game stays at 0.80.
- No reservation or guard moved: `fn_crash_decide` still refuses a payout above the round's reservation, and the pool still re-checks paid + reserved against what it took in.
- The wheel: its draw, weights and reservations are unchanged and still sum to 0.8. Played, a Crash award is now worth its own return, so the wheel pays back 0.825494 of the entry (0.827405 at the smallest odd entry), and 0.845800 of everything taken in if every Crash award buys the add-on, the house's worst case. Below 100 percent every way, so no owner decision was needed.

## Every round can reach 20x

Every Crash config is fixed at 20x by the clamp, `fn_crash_start` takes LEAST(cap, 2000), and a wheel-funded flight that cannot cover 20x is refused rather than shortened. Ordinary awards reserve 40x of their base and Super awards 30x, which is exactly 20x of the largest stake either can be played at. The un-awarded path (`cap_fraction` of the pool headroom) is refused while the wheel's v2 release is on, which it is. Measured on production before the install: all 19 Crash rounds ever sealed had a cap of 20x or more; none was truncated. `fn_diamond_game_cap_cents` is not changed: it takes the config's 2,000 as its ceiling for Crash, and it is shared by every game and by the wheel's admission, which asks it for 4,000 and 3,000.

## On screen

- Before Start and through the climb: "Average Crash 2.9x. Up To 20x." computed from that round's own stake, sealed minimum, contract and cap.
- After a booked win (by hand or on auto) the flight keeps climbing to the sealed point and the plate, the readout and the receipt say "It Would Have Crashed At 4.37x", or "It Would Have Reached 20x". The point reaches the browser only in the settled receipt.
- The lobby shows "Average Crash 2.9x" on both award kinds and prices the instant crash at the contract the server deals.

## Install

Migration `20261012114801_crash_never_ends_before_1_25x_averages_2_9x_and_flies_to_20x.sql`: one transaction, md5 preimage guards on every live body replaced (including `fn_wheel_bonus_state` as the Donkey Cross install left it, `2c458d77055bad763d2a3255036977af`), a readback that raises unless the returns, the floor, every target's value and the averages are as designed. Installed after the client was live; the evidence is recorded in the follow-up that names the provider version.
