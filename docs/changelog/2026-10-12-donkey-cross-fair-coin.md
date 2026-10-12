# Donkey Cross flips a fair coin on every street (contract 6)

**Owner request, 2026-10-11 (Dan, verbatim):** "DONKEY CROSS ALWAYS RUNS THE
DONKEY OVER ON THE 2ND STREET. IT NEEDS TO LITERALLY BE A 50/50 CHANCE TO CROSS
THE NEXT STREET. 'A VIRTUAL COIN' MUST FLIP THAT IS TRULY RANDOM TO BE SAFE OR
SMASH FOR EACH STREET EVERY TIME. AND WHEN A USER 'BOOKS THE WIN' IT SHOULD SHOW
THEM HOW FAR THEY 'WOULD OF GOTTEN'."

**Money ruling, same night:** "Smaller prizes, keep 80%."

Scope: Donkey Cross only. Diamond Mines stays on contract 5, untouched.

## Why the second street "always" hit

Under contracts 4 and 5 street one was certain (0.80x, owner ruling R3 of
2026-09-21) and one sealed 48-bit roll decided the whole road against a ladder
of 0.80x, 1.45x, 1.85x ... 20x. Keeping 0.80 of the stake at every stop with
that ladder left street two a 31.6% chance (1.5% on a Super award with the
add-on). That is what Dan saw.

## What changed

- **The coin.** Street k flips its own sealed coin:
  `HMAC-SHA256(key = server seed, message = client_seed:nonce:street:k)`,
  SAFE when the first byte is below 128. Exactly half of all byte values, every
  street, street one included, each street on its own message so no coin says
  anything about another. The server seed is committed by its hash before the
  player chooses a seed, so neither side can steer a coin.
- **The ladder** comes from the round's own floor L and stake B:
  `prize_1 = 1.6B - L`, `prize_(k+1) = 2 prize_k - loss_k`, where `loss_k` is
  contract 5's rule (the greater of the floor and half the last safe prize).
  With a fair coin that makes booking after any street worth exactly 0.80B; the
  top is capped at 20B (worth a little less), at most 20 streets, and the cap
  and reservation cut it short exactly as before.
  - Standard (L = half): 1.10x, 1.65x, 2.47x, 3.70x, 5.55x, 8.32x, 12.48x,
    18.72x, 20x (nine streets).
  - Super without the add-on keeps the half floor, so the same road.
  - Super with Double Diamonds (L = two thirds): 0.93x, 1.20x, 1.73x, 2.60x,
    3.90x, 5.85x, 8.78x, 13.16x, 19.74x, 20x (ten streets). Its first street
    is below 1x because the higher floor already guarantees more on a smash.
- **The reveal.** A finished contract-6 round's proof carries every coin and
  `road_end` (the street the donkey would have reached). On booking a win the
  console and the receipt now show one headline in gold, for example "You Would
  Have Got To Street 5 At 5.57x, Then Been Hit On Street 6", plus the sealed
  coins ("1 Safe - 2 Safe - ... - 6 Hit"). The odds line reads 50% on every
  street. The rules panel says it is a fair coin.
- **The replay.** `fn_diamond_bonus_replay` computed `road_end` with the
  contract-4 formula for every round, so a contract-5 replay named the wrong
  street. Each contract now has its own branch; a contract-6 replay also
  carries its coins and its own street multipliers, which the replay scene
  paints.
- **Sealed rounds.** `fn_choice_act` keeps the contract-4 and contract-5
  survival rules byte for byte. Rounds already open settle exactly as they
  were dealt.

## How it was proven

- `tests/the-games-never-pay-more-than-they-take-in.law.test.ts` item 9: every
  stake from 25 to 7,500 diamonds on every floor a round can carry, every
  stopping point, exact integer arithmetic: never more than 0.80, exactly 0.80
  below the top. The coin is one byte, half of all byte values safe; over 2,048
  seeds each of ten streets survives half the time, a safe street predicts
  nothing about the next, and street one smashes about half the time.
- `tests/sql/diamond-crossing-fair-coin.sql` on the isolated Postgres 17
  fixture: 400 real paid rounds through the installed doors, every street the
  coin its seed flips, receipts reveal the coins and the road end, each loss
  and each win paid exactly once; 65,540 coins straight from the installed
  function (49.96% safe; after a safe street 49.83%); every stake and floor's
  ladder worth at most 0.80.
- `crossing-v5-before-v6.sql` / `crossing-v5-after-v6.sql`: a contract-5 round
  left open across the install settles under contract 5, pays once, and
  replays contract 5's street (both outcomes were run).
- `tests/unit/roadCoin.test.ts`: real contract-6 receipts captured from the
  installed migration verify on the client from the revealed seed; a flipped
  coin, a moved road end or a changed prize fails its own check. The client
  ladder and coins were also compared against the installed SQL for every
  stake 25..7,500 on three floors and 300 seeds (identical).

## Release order (the client must understand contract 6 first)

1. Merge and publish this client (it reads contracts 4, 5 and 6).
2. Confirm the published bundle at both build-info endpoints.
3. Only then install `20261012050006_donkey_cross_flips_a_fair_coin_every_street.sql`,
   once, outside the :50-:03 break window. Its preimage guards abort if any
   replaced door changed since 2026-10-12 00:20 UTC.
4. Read back the eleven `@live-proof` postimage hashes.

A client that cannot read contract 6 would refuse every new Donkey Cross
receipt, so step 3 must never come before step 2. No engine change.
