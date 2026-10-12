# One wheel for everyone

**Owner request, 2026-10-12 (Dan), verbatim:** "THE VIP WHEEL THAT ONLY AWARDS
DIAMONDS, CHIPS OR BONUS GAMES SHOULD BE THE SAME WHEEL THAT NON VIP MEMBERS
GET. THERE SHOULDN'T BE A DIFFERENCE. CHANGE THAT PLEASE."

**Decision announced to Dan:** every member, VIP or not, gets the VIP wheel
(Diamonds, chips, Upgrade and bonus games only). Nobody wins a Throwable, a
Time Bank or a Rabbit Hunt from the wheel. The server deals it; the browser
only checks it.

## What every player's wheel holds now

| Ord | Prize          | Weight (of 100,000) |
| --- | -------------- | ------------------- |
| 1   | Diamond Plinko | 11,950              |
| 2   | 1x Chips       | 29,600              |
| 3   | 0.2x Chips     | 6,667               |
| 4   | Diamond Crash  | 11,950              |
| 5   | Diamonds       | 1,200               |
| 6   | 0.25x Chips    | 6,666               |
| 7   | Donkey Cross   | 11,950              |
| 8   | 2x Chips       | 240                 |
| 9   | 0.3x Chips     | 6,667               |
| 10  | Diamond Mines  | 11,950              |
| 11  | 3x Chips       | 160                 |
| 12  | Upgrade        | 1,000               |

A bonus game, the Diamonds card game or the Upgrade half the time; instant
chips the other half. The payback is still exactly 0.8 of the entry
(`sum(weight * value_sixths) = 480000`), because ords 3, 6 and 9 pay
`0.2*6667 + 0.25*6666 + 0.3*6667 = 5000`, exactly what the three items
(`0.25 * 20000`) were worth. The weights and the no-repeat follow-up matrix did
not move.

## The root change

`supabase/migrations/20261012041752_one_wheel_for_everyone.sql`, one
transaction:

1. **`fn_wheel_v4_model(p_vip)` returns one table.** The VIP columns of
   20260922194123 are now the only columns. `p_vip` is kept so every caller
   (`fn_wheel_v4_segments`, the spin, the state, the CI contract reader) still
   resolves, but it selects nothing. The migration asserts the installed table:
   12 ords, 100,000 weight, 480,000 value-sixths, no item kind, identical for
   `true` and `false`.
2. **`fn_wheel_spin_v2` stops asking who is spinning.** `v_vip:=true` replaces
   `fn_wheel_is_vip(v_user)`. The model guard before every draw now refuses any
   table carrying an item kind for everybody (it used to check only for a VIP).
3. **`fn_wheel_state_v2` shows the same table to everybody**, the same way.

Both functions were patched in place from their live bodies, like the
2026-10-10 wheel migrations: refused unless the md5 is exactly what was read
from production on 2026-10-12, edited only at anchors that must occur exactly
once, and re-executed. If production drifts before this is applied, it aborts
and changes nothing.

| Function               | Live preimage (read 2026-10-12)    | Qualified postimage                |
| ---------------------- | ---------------------------------- | ---------------------------------- |
| `fn_wheel_spin_v2`     | `3a5c2e4182a60bf90c3f011dac16d99d` | `26b56f5b349b148378bbad2e093d06eb` |
| `fn_wheel_state_v2`    | `b6c4224bcbd24cf0571b9096477d8d64` | `f68734ab6d38159c2d3e2aa25340d66c` |
| `fn_wheel_v4_model`    | `f440ca3d4519d16f691cf2c342ec2d05` | `ee7ba6f14477726303e1da553b9a7953` |
| `fn_wheel_v4_segments` | `586d1be1986b0701516ac4cab76a34bb` | unchanged (pinned only)            |

The postimages are what the isolated PostgreSQL 17 Diamond fixture produced
after applying the file. Its preimages are byte-identical to production's. The
md5s are written as `@live-proof` lines so `check-migrations-are-live` can
confirm the install.

## The `vip` field on receipts

`vip` on a v4 receipt and state has always told the browser **which table the
spin was drawn from**: `true` is the item-free table, `false` the item table.
Every spin now comes from the item-free table, so the server answers
`vip: true` for every player. This is deliberate:

- the client already in production accepts a `vip: true` receipt carrying
  exactly this table, so the database can go first;
- a receipt sealed before the change on the item table still says
  `vip: false` and still verifies against the table it was drawn from, so
  replays and recovery of old spins keep working;
- the two can't be mixed: an item receipt relabelled `true`, or a chip
  receipt relabelled `false`, is refused (pinned in
  `tests/unit/wheelV4PostgresContract.test.ts`).

The client validator (`src/utils/wheelAward.ts`) keeps its logic and now
documents what the flag means. `fn_wheel_is_vip` stays installed with no wheel
caller. It is a pure read, and dropping it would gain nothing.

## The dead item-price gates

Both functions closed the wheel for a non-VIP whenever the throwable / rabbit
hunt / time bank prices in `feature_pricing` moved away from the values the
quarter-entry item conversion was qualified at. No spin can draw an item now,
so both gates are **removed**. Leaving them would have kept a way for the
wheel to close for a reason it no longer has. The item-granting branch inside
`fn_wheel_spin_v2` stays in the body but can't be reached: the model guard
refuses any table with an item kind before the seed is read.
`tests/sql/diamond-wheel-one-table.sql` moves the throwable price and proves
the wheel stays open and still spins.

## Nothing sealed is rewritten

Unplayed bonus games, unpicked card games, open runs, paid batch tickets and
stored receipts are untouched. Inventory already granted by the wheel stays
with the player.

## Release order

No engine change. **Either order is safe:**

- **Database first** (recommended, because it is the change Dan asked for):
  the deployed client already accepts `vip: true` with this table, which is the
  VIP path it has served since 2026-09-23.
- **Client first:** the new client changes only comments and tests; its
  validator logic is unchanged, so it keeps working against the current
  two-table server.

After applying: re-read the three md5s above from production, and read
`fn_wheel_state_v2` as a non-VIP to confirm `vip: true` and twelve segments with
no item. Then refresh `tests/fixtures/diamond-spins/wheel-v4-live-definitions.json`
from production (its `fn_wheel_v4_model` body is currently the qualified
fixture postimage, labelled as such).

## Tests

- `tests/sql/diamond-wheel-one-table.sql` (new, runs in
  `scripts/dev/test-accounting-delivery.sh` right after the migration): a
  non-VIP and a lifetime VIP are shown identical tables; the non-VIP lands ords
  3, 6 and 9 and is paid 0.2x / 0.25x / 0.3x chips with ledger rows and no
  grant; 300 real non-VIP spins give no item, no repeat, the published
  follow-up row each time, and a 149/151 game/chip mix; a paid batch of five
  deals the same table; a moved item price no longer closes the wheel. Then the
  atomic batch probe is re-run on the patched spin. The whole harness passes
  on PostgreSQL 17.
- `tests/the-wheel-never-pays-more-than-it-takes-in.law.test.ts`: the payback
  is still exactly 0.8 at every stake, and the one table is row for row the
  retired VIP table.
- `tests/unit/wheelV4LiveContract.test.ts`, `tests/unit/wheelV4PostgresContract.test.ts`
  (with real post-migration receipts), and
  `tests/components/DiamondWheelOneTableFace.test.tsx` (renamed from
  `DiamondWheelVipFace`).
- `scripts/diamond-spins/wheel-v4-follow-matrix.py` now derives one table and
  proves the 50/50 mix and the 0.8 payback; `src/utils/wheelV4Model.ts` was
  regenerated from it (only comments changed; every number is the same).
