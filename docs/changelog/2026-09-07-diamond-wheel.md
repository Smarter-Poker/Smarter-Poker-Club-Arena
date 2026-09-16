# The Diamond Wheel

**2026-09-07 / 08. Dan: "I want to add a Diamond To Chip spinning wheel game
to the Club Arena, where players can potentially convert their diamonds into
chips ... costing a certain amount of diamonds per spin, and awarding prizes,
chips, diamonds, or nothing. House edge on this should be 20% and never pay
more out than we take in." Then, the same evening: "1 diamond = 1 cent, 1 chip
= 1 dollar. Adjust everything accordingly." Then: "Proceed the build out of
this in full."**

The plan this implements is the artifact "Diamond Wheel Game Plan" (rev 2). The
decisions it left to Dan were taken at their recommended settings, per his
standing instruction that an approved plan proceeds without re-asking: 100
diamonds a spin, the host union is the issuer of record and receives the chip
share of every spin, purchased diamonds only at launch, a 500-chip exposure
allowance, a 50-chip top prize, commit-and-reveal fairness.

## What shipped

### The rate is a row, and the owner bridge was wrong by ten thousand times

`ca_bridge_rate` holds the one diamonds-per-chip figure (100), with a history
table written by trigger, read by `fn_ca_bridge_rate()`. The live owner bridge
`fn_mint_chips_from_diamonds` carried `v_chips := v_diamonds * 100` in its
body, which under Dan's rates minted one hundred dollars of chips for one cent
of diamonds. Owner-only, fired three times ever (3 diamonds became 300 chips
on 2026-08-21, inside the acknowledged baseline). Corrected forward to read
the row and refuse a conversion that does not land on whole cents. Nothing
clawed back (CLAUDE.md 10.9). Diamond Standard decision 7 is closed.
Migration `20260907233813`.

### The vocabulary

`chip_ledger_category_check` learns `wheel_prize` (its own migration,
`20260907235112`: the first attempt inside the larger transaction deadlocked
against live play, 40P01, and rolled back clean - one hot table, one
transaction, nothing else held). `ca_payout_freeze` learns scope `wheel`.
`fn_ca_diamond_engine_of` maps a `wheel:` reference to engine `wheel`, with a
50,000-a-month budget line and a 10,000-a-day per-player cap (DR7 warns, never
refuses a drawn prize).

### The wheel (`20260907233833`)

Tables: `wheel_segment_versions` and `wheel_segments` (the prize table,
versioned; version 1 seeded and activated), `wheel_configs` (one per host, a
union or a standalone club, with a history table), `wheel_pools` (the
economics: spins, intake, chips minted, the mint carry, chips paid, the diamond
float, diamonds paid, constrained spins), `wheel_seed_commits` and
`wheel_spins` (append-only). All closed to the browser; the RPCs are the doors.

How one spin moves money, in one transaction under one lock on the host's
config row:

1. `deduct_diamonds` takes the spin (type `wheel_spin`, reference
   `wheel:<spin>`, class spend, counterparty `revenue:wheel_spin`; the
   register retires it as it retires every spend). Under `purchased_only` the
   spend is taken FIFO from `diamond_purchase_lots` and refused past them.
2. The chip share of the spin (0.743 chips on a 100-diamond spin under version
   1: the expected chip payout of the table) is minted to the host bank,
   declared `mint` from `issuance_reserve` with key `wheel-mint:<spin>`; the
   chip_ledger issuance trigger registers it in `ca_mint_ledger` and holds it
   to `ca_mint_policy`. Sub-cent fractions carry to the next spin.
3. The diamond share (0.057) accrues to the pool's diamond float. A diamond
   prize is credited through `add_diamonds_to_balance` (type `wheel_prize`,
   reference `wheel:<spin>:prize`, engine `wheel`) and drawn from the float.
4. The rest, 20 percent, is retired diamonds: the house, revenue recognised at
   consumption (Diamond Standard D1).
5. Eligibility: a chip tier only when `chips_paid + prize <= chips_minted +
this mint + exposure_allowance` AND the host bank holds it; a diamond tier
   only when the float covers it. Locked tiers are returned with the figure
   that unlocks them.
6. The roll is HMAC-SHA256(server_seed, `client_seed:nonce`), first six bytes
   over 2^48, onto the eligible weights - the spin draw's own mapping. The
   server seed was committed by hash before Spin (`fn_wheel_commit`) and is
   revealed after; `src/utils/wheelFairness.ts` recomputes it in the browser
   and `tests/unit/wheelFairness.test.ts` pins it to a Postgres vector.
7. A chip prize is one journal row, host bank to `club_members.chip_balance`,
   category `wheel_prize`, counterparty `union_bank` or `club_treasury`, host
   side autoskipped because `union_wallet_transactions` (or the
   `chip_transactions` receipt) records it - the shape of
   `fn_union_send_to_member_zd3core`.

The guarantee: payouts come only from the host bank and only within
`chips_minted + allowance`; `chips_minted` is 0.743 of intake by construction;
diamond prizes come only from a float that accrues 0.057 of intake. Cumulative
value paid <= 0.80 x cumulative intake + allowance, by arithmetic, whatever the
RNG does. `fn_wheel_metrics` re-derives the inequality and files a CRITICAL
drift incident if it ever fails, which it cannot: the alarm is for a bypass.

RPCs: `fn_wheel_state`, `fn_wheel_commit`, `fn_wheel_spin`, `fn_wheel_history`
(players; every one reads `auth.uid()`), `fn_wheel_set_config` (host owner via
`fn_union_can_manage_wallets`, a standalone club's owner / co_owner / admin, or
management), `fn_wheel_activate_segments` (management; refuses any table whose
return is not exactly 0.800000 on 100,000 weight), `fn_wheel_metrics`
(operators: exposure, realised return as a z-score per window, lock rate, the
invariant). The money movers are on `ca_money_rpc_registry`.

### Two fixes the rolled-back probe found (`20260908001056`, `20260908001349`)

- The prize leg's autoskip GUC is transaction-scoped and was never cleared, so
  a second spin in the same transaction minted with no journal row; the
  function's own check refused it. The prize leg now clears both autoskips.
- `fn_guard_profile_privileged_columns` refused the diamond prize from a
  player's call (42501). `fn_wheel_spin` joins its call-stack allowlist beside
  `fn_ca_daily_bonus_claim`; the patterns use bracket expressions so backslash
  handling can never matter. `fn_wheel_metrics` took `sqrt` of a bigint
  (double precision) into `round(…, 2)`, which does not exist; `sqrt(n::numeric)`.

### The probe (rolled back, CLAUDE.md 11.5)

One `DO` block ending in `RAISE EXCEPTION`, as vinniecards in Club JAQK on the
Midway Union's wheel: state before config is `not_configured`; a plain member
cannot configure; a 150-diamond price is refused (not a multiple of the table's
100); a spin without a commit is refused; 80 spins; the revealed seed hashes
to the commitment; the roll recomputes from HMAC; a second call on the same
commit replays the same spin; then the arithmetic: diamonds moved = spins x
100 - diamond prizes; union bank moved = minted - paid; member wallet moved =
paid; paid <= minted + 500; 80 mint legs, 55 `wheel_prize` legs, 88 diamond
journal rows, 0 suspense legs, 0 write failures, 0 diamond incidents; metrics
invariant holds, z = 0.85 on a hot 104.8 percent run (exposure 21.66 of a 500
allowance). Production supply unchanged before and after.

### The front end

`src/pages/DiamondWheelPage.tsx` at `/clubs/:clubId/wheel` (member route): the
wheel, the odds table with locks and their unlock figures, the pool's realised
return, the fairness panel (commitment hash, editable client seed, revealed
seed, roll, a Verify button that runs the check in WebCrypto) and the player's
history. `src/components/wheel/DiamondWheel.tsx` draws the wheel in SVG:
brushed-gold rim with lamps, three materials for the three kinds, a jewelled
hub and a gold pointer; it lands on the ord the server names, never chooses,
carries `data-motion="keep"` and scales with `--animation-speed`.
`src/pages/club/ClubWheelOperationsPage.tsx` at `/clubs/:clubId/wheel-operations`
(finance access in the operations registry): open/close, price, allowance,
caps, purchased-only, the six readings and the per-window z table. A banner on
the club's Promotions page is the player's door.

### Not built, on purpose

- Consumable prizes (rabbit hunts, time banks): no prepaid-credit inventory
  exists for them, and `fn_reveal_rabbit_hunt` charges per use. The plan's
  consumable tier became a 25-diamond tier of the same value. When a credit
  inventory exists, a version 2 table can carry it.
- Horses on the wheel: excluded at launch by `purchased_only` (a horse holds
  no purchased lot), without a horse-specific branch (CLAUDE.md 10.5).
- A progressive top tier from the float's surplus: a version 2 change once
  the float has a month of history.
- A free daily spin from the Daily Club Arena Bonus: cheap once the wheel
  exists; it puts promotional diamonds on the wheel and wants its own budget.

### Still Dan's

- Turning a host's wheel on. No `wheel_configs` row exists; nothing is enabled.
  The operator page (or `fn_wheel_set_config`) creates it.
- The policy reversal itself: on 08-19 player diamond-to-chip conversion was
  revoked and the Diamond Standard treats closed loop as a hard property (D5,
  DR16). This wheel reopens it with dice, paying dollar chips. Counsel's read
  belongs before the first host is enabled; DR16 should gain an exception
  naming the wheel and its rules.
- The lock rate on a cold float: the 250-diamond tier is locked until the
  float accrues about 245 diamonds (43 spins) and re-locks after every hit.
  That is the hard cap being honest. A platform-seeded diamond float would
  change it; the house holds 0 diamonds today.
