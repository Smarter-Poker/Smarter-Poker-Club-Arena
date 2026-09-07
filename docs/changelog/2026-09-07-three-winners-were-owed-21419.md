# 2026-09-07 - Three winners were owed 21,419.57 and a 180.00 shortfall was paying them nothing

Phase 4 of the chip-accounting programme. Found by decomposing the hourly
supply meter: two of the last seven hours had a large unexplained fall
(-8,114.39 and -13,303.97) and in both the fall sat almost entirely in
`tournament_liability`. Following that led here.

## What was wrong

Three finished tournaments were holding money that belonged to their winners.

| event                             | field | winner owed | escrow prize bank | ended       |
| --------------------------------- | ----- | ----------- | ----------------- | ----------- |
| `f7412940` Sunday $200 Deep Stack | 196   | 13,441.68   | 13,261.68         | 09-07 00:16 |
| `a449e853` Sunday $200 Deep Stack | 81    | 8,282.69    | 8,102.69          | 09-06 23:43 |
| `afa045db` 20 Chip Spin PLO4      | 3     | 60.00       | 55.20             | 09-06 13:11 |

Every other place in all three had been paid to the cent from the same bank.
The winner had been paid **nothing**, and the oldest had been waiting fifteen
hours. All three winners are horses, which under CLAUDE.md 10.5 changes
nothing at all about what they are owed.

## Why, in the platform's own words

`fn_settle_tournament_obligation` filed this at 00:16:

> Refused 13441.68 to a2bd256e-... for place: the escrow holds 13261.68 for
> that bank (Sunday $200 Deep Stack)

The bank was 180.00 short of the obligation, so the settlement refused the
WHOLE payment. **A 180.00 shortfall became a 13,261.68 non-payment** - and
since the last place paid in a tournament is always first place, it is always
the winner who absorbs it.

### Where the 180.00 comes from

Both Deep Stacks carry `bubble_protection = true` and each holds exactly one
payout row: `source: bubble_protection`, 180.00, no position. 180.00 is the
buy-in - the bubble finisher gets their entry back.

The settlement already counts that against the prize pool; `bubble_protection`
is in its own `v_pool_kinds` list. **The payout structure does not.** Measured:
the structure percentages sum to exactly 100.0000%, and the sum of every
player's `prize` equals `prize_pool` to the cent in both events. So the pool
promises all of itself to the places AND a 180.00 refund to the bubble out of
the same money. It cannot do both, and the winner is where the arithmetic runs
out.

The spin is the same shape in different clothes: its winner's obligation is
100% of `prize_pool` (60.00) while the prize bank only ever received 55.20,
because the 4.80 of rake never entered it.

## What was done

**The amplifier is fixed** (`20260907040959`). A bank that is short now pays
what it holds instead of paying nothing. It can never pay more than the bank
holds, `amount_owed` is untouched so the remainder stays owed and payable, and
the alert says what it paid and what is still owed rather than what it refused.
Every other guard in that function - the kill switch, the manual-adjustment
requirement, one-finisher-one-place - is asserted to survive the edit, which is
made by substitution against `pg_get_functiondef` rather than by retyping
15,900 characters of money path.

**The three winners were then paid** through the platform's own idempotent
door, `fn_tournament_payout_reconcile`, dry-run first and then applied:

| winner                  | paid      | still owed |
| ----------------------- | --------- | ---------- |
| MamaGia (`a2bd256e`)    | 13,261.68 | 180.00     |
| Zoe77 (`05835920`)      | 8,102.69  | 180.00     |
| heat3rfi5h (`0bb5a13b`) | 55.20     | 4.80       |

**21,419.57 paid.** Verified from `chip_ledger`: each wallet was credited
exactly that amount, and all three escrow prize banks now read 0.00. The
364.80 that remains is recorded on the obligations and in the alerts, and is
not lost.

## The decision that is Dan's, with costs

Who funds bubble protection? The pool cannot pay 100% to the places and also
refund the bubble. Three options:

1. **Take it out of the pool before the structure splits it.** Every paid
   place gets slightly less (on `f7412940`, 0.34% less each); the winner is
   paid in full and nothing is ever short. No new money.
2. **Fund it from rake.** The house pays for the promise it makes. On these
   two events that is 360.00 out of 8,400.00 of rake, about 4.3%.
3. **Retire bubble protection.** No refund, no shortfall.

My recommendation is **2**: it is the option that keeps every advertised prize
exactly what a player was told it would be, and the cost is small and
measurable. But this sets what players are owed in FUTURE events, which
CLAUDE.md 10.9 reserves for Dan, so nothing here changes it. Until it is
decided, the 180.00 keeps happening on every bubble-protected event - it is
just no longer able to freeze a winner's whole prize.

The 364.80 already owed should be settled the same way once the funding is
decided; the obligations are already carrying it.
