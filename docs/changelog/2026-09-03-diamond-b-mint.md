# Lane B: issuance through the Mint (diamonds)

2026-09-03, Club Arena. Diamond Accounting Standard 2.3, 3.2 "Earn" 5 and 6,
3.3 DR2 and DR14, section 5 "Lane B". Everything below is observed: numbers
from queries run against production, and rolled-back probe transcripts.

## What the database said before

Read 2026-09-02 22:50 to 2026-09-03 02:00 UTC.

| Measure                                    | Value                                                        |
| ------------------------------------------ | ------------------------------------------------------------ |
| `SUM(profiles.diamonds)`                   | 1,030,092 over 1,308 rows                                    |
| `ca_mint_ledger` rows, any asset, ever     | 0                                                            |
| `fn_ca_mint_supply('diamonds')`            | 0                                                            |
| `ca_diamond_house.balance`                 | 0 (one row, id = 1)                                          |
| `ca_diamond_incidents` rows                | 0                                                            |
| `ca_mint_ledger_holder_type_check`         | club, union, player                                          |
| `diamond_transactions` type `signup_bonus` | 212 rows / 63,600, none since 2026-02-12                     |
| `signup_errors` rows, all time             | 24                                                           |
| `ca_money_rpc_registry` diamond entries    | `fn_ca_mint` only; `fn_ca_burn` and `handle_new_user` absent |
| `fn_ca_mint` / `fn_ca_burn` grants         | postgres, **authenticated**, service_role                    |
| `length(prosrc)`                           | fn_ca_mint 6,499; fn_ca_burn 6,833; handle_new_user 5,472    |

The signup grant stopped journaling because its guard is
`COALESCE(v_prev_diamonds,0) = 0 AND v_now_diamonds = 500`, which is only true
when `handle_new_user` created the profile itself. 416 horses seeded since
2026-09-01 arrived with the profile already holding 500, so the ON CONFLICT
path ran with `v_prev_diamonds = 500` and wrote nothing: 208,000 diamonds into
supply with no row in any ledger. `zz_ca_audit_diamond_change` is
`AFTER UPDATE OF diamonds`, so `ca_diamond_balance_audit` did not see the
INSERT either.

Only 24 `signup_errors` rows exist in total, so those 416 profiles were NOT
the result of `handle_new_user` failing and the seeder cleaning up after it.
`profiles.id` carries a live FK to `auth.users(id)`, so the profile cannot
physically precede the auth row; the 2 ms gap the audit measured is a
`created_at` value the seeder wrote, not an insert order. The seeder that
created them was not found in either repo (lane 3 section 13, UNKNOWN), and
the most likely shape is an insert with the trigger suppressed. **If that is
what it does, part 1 alone would still not journal those horses and part 2's
trigger would not fire either.** Part 2's incident feed is what will say so:
a seeded profile that produces no `DR2:balance_born_outside_the_mint` row is a
profile inserted with triggers off, and that is now visible instead of silent.

## What shipped

Two migrations, each one transaction, each applied once, each with
`SET LOCAL lock_timeout = '4s'`.

`20260903002248_diamond_b_the_mint_issues_diamonds.sql`

1. `ca_mint_ledger.holder_type` learns `house`. `holder_id` gains a COMMENT
   naming the sentinel `00000000-0000-0000-0000-00000000d1a0`, used because
   the house is a single-row table keyed `id = 1` and has no uuid of its own.
2. `fn_ca_mint` and `fn_ca_burn` DROPped and re-created (the argument list
   changes) with destination / source `house` for diamonds and a trailing
   `p_class text DEFAULT 'admin'` validated against the foundation's
   `issuance_class` list. The diamond journal row now carries
   `counterparty = 'issuance'` on a mint and `'retired'` on a burn, plus the
   class. The house branch moves `ca_diamond_house.balance` and writes NO
   `diamond_transactions` row, because that journal is FK-bound to a user.
   Every other behaviour carried across: the service_role-or-admin/god gate,
   whole diamonds, two-decimal chips, the 10-character reason, the `op_id`
   claim in `ca_op_claims` with replay, `pg_advisory_xact_lock`, the caps
   (1e9 chips / 1e7 diamonds), `supply_after`, and both chip branches.
   Reconstruction proof: `length(prosrc)` 6,499 -> 8,281 (`fn_ca_mint`) and
   6,833 -> 8,449 (`fn_ca_burn`), the growth being the house branch, the class
   validation and their comments.
3. `handle_new_user` journals the 500 on BOTH paths. New guard:
   `v_now_diamonds = 500 AND COALESCE(v_prev_diamonds,0) IN (0, 500)`, class
   `promotional` when this function granted it and `seeded` when it arrived
   with the profile; `reference_id = 'signup:<uid>'`,
   `counterparty = 'issuance:signup'`, `source = 'handle_new_user'`,
   `balance_after = 500`. It also writes the matching `ca_mint_ledger` row,
   skipped when a `signup:` or `seed:` op_id for that user already exists so
   the same 500 cannot be registered twice. Both writes sit in a nested
   `BEGIN ... EXCEPTION WHEN OTHERS THEN PERFORM fn_ca_diamond_incident(...)`,
   so a ledger failure files `DR2:signup_grant_not_journaled` and never blocks
   a signup; the outer `signup_errors` handler is untouched. Nothing else in
   the function changed: the VIP grant, the multiplier, the player-number
   sequence, the username derivation and the reserved-name fallback are
   byte-identical. `length(prosrc)` 5,472 -> 8,369.
4. One acknowledged-baseline row, modelled on the chip precedent
   `20260828082815_the_pre_funding_minting_becomes_an_acknowledged_baseline.sql`:
   `op_id 'baseline:diamonds:2026-09-03'`, action mint, holder_type house,
   amount computed in the migration as `SUM(profiles.diamonds)` (never typed),
   reason `pre-standard diamond circulation acknowledged as baseline
2026-09-03`. Nothing is backfilled and no balance moves. Its
   `balance_before` / `balance_after` of 0 -> 1,030,092 describe the recorded
   position of all player wallets taken together, NOT `ca_diamond_house`,
   which the migration asserts is still 0.
5. `fn_ca_mint`, `fn_ca_burn` and `handle_new_user` registered in
   `ca_money_rpc_registry` (skipping any Lane A already added).

`20260903002333_diamond_b_a_balance_born_outside_the_mint_is_recorded.sql`

`zz_ca_diamond_born_with_balance`, `AFTER INSERT ON public.profiles FOR EACH
ROW WHEN (NEW.diamonds IS NOT NULL AND NEW.diamonds <> 0)`. It files
`DR2:balance_born_outside_the_mint` (warning) with the amount, the db_role,
the application_name, the username and `is_horse` as DATA, and inserts a
`ca_mint_ledger` row `op_id 'seed:<profile id>'` so the register keeps
matching `SUM(profiles.diamonds)`. Both writes are in their own
`EXCEPTION WHEN OTHERS`; the function contains no `RAISE EXCEPTION` and
returns NULL. It writes no `diamond_transactions` row on purpose: that journal
has FKs to both `auth.users` and `profiles`, and `handle_new_user` writes it a
moment later.

It fires on every signup, including the profile `handle_new_user` inserts
itself, because that INSERT also carries 500 and is also a balance born
outside the Mint. Expect roughly one warning per new profile (419 in the 48
hours to 2026-09-02) until the seeder and `ensure-profile.js` are changed to
insert 0 and let the grant flow through the Mint.

## Observed after apply

```
supply                1030092.00    (fn_ca_mint_supply('diamonds'))
profiles_total         1030092       (SUM(profiles.diamonds))
ca_mint_ledger rows    1             (the baseline)
ca_diamond_house       0
fn_ca_mint acl         postgres=X | service_role=X      (authenticated removed)
```

Both migrations' own DO-block assertions passed at apply time: the supply
identity, the widened holder CHECK, the ON CONFLICT branch present in
`pg_proc.prosrc`, both Mint doors knowing `ca_diamond_house`, all three
registry rows, and the trigger's shape.

## Rolled-back probes

Every probe ran inside `BEGIN; ... ROLLBACK;` against production. After each
one: `ca_mint_ledger` back to 1 row, `ca_op_claims` 0 probe rows,
`ca_diamond_incidents` 0, `ca_diamond_house.balance` 0, no probe profiles or
auth rows, supply 1,030,092 = profiles 1,030,092. No diamond moved.

### (a) and (b) The house as a destination and as a source

`fn_ca_mint('diamonds','house',<sentinel>,10,'probe: house destination for
guarantees','probe:house:mint:aa11')` then
`fn_ca_burn('diamonds','house',<sentinel>,4,'probe: house retirement mirror
check','probe:house:burn:aa11')`, both as service_role
(`set_config('request.jwt.claims','{"role":"service_role"}',true)`).

```
house_balance_after_both   6
diamond_tx_rows_for_house  0        <- the house writes no user journal row

ca_mint_ledger
  probe:house:mint:aa11  mint  house  10.00  before 0.00  after 10.00  supply_after 1030102.00
  probe:house:burn:aa11  burn  house   4.00  before 10.00 after  6.00  supply_after 1030098.00
  holder_id on both: 00000000-0000-0000-0000-00000000d1a0, holder_label "the house"

fn_ca_mint returned  {"ok": true, "destination": "house", "issuance_class": "admin",
                      "balance_before": 0, "balance_after": 10, "supply_after": 1030102.00}
fn_ca_burn returned  {"ok": true, "source": "house", "issuance_class": "admin",
                      "balance_before": 10, "balance_after": 6, "supply_after": 1030098.00}
```

### (c) and (d) A seeded profile and the ON CONFLICT journal branch

Two users in one rolled-back transaction. P1 is an ordinary signup: one
`auth.users` INSERT with every trigger live. P3 is the seeder shape: because
`profiles.id -> auth.users(id)` is a live FK, the only way a profile can
pre-exist `handle_new_user` is for the auth row to land with triggers off, so
the probe inserted it under `SET LOCAL session_replication_role = 'replica'`
and then wrote the profile directly, with triggers back on, already holding
500 and `is_horse = true`.

```
profiles
  ...c0d1  probelanebone    500  is_horse false   (handle_new_user created it)
  ...c0d3  probehorselaneb  500  is_horse true    (written directly, seeder shape)

ca_diamond_incidents
  ...c0d1  DR2:balance_born_outside_the_mint  warning  500  writer "profiles INSERT"
           detail {db_role postgres, app_name mgmt-api, is_horse false, username probelanebone}
  ...c0d3  DR2:balance_born_outside_the_mint  warning  500  writer "profiles INSERT"
           detail {db_role postgres, app_name mgmt-api, is_horse true,  username probehorselaneb}

ca_mint_ledger
  seed:...c0d1  mint  player  500.00  0.00 -> 500.00  supply_after 1030592.00  by zz_ca_diamond_born_with_balance
  seed:...c0d3  mint  player  500.00  0.00 -> 500.00  supply_after 1031092.00  by zz_ca_diamond_born_with_balance

diamond_transactions
  ...c0d1  signup_bonus 500  balance_after 500  reference signup:...c0d1
           source handle_new_user  counterparty issuance:signup  issuance_class promotional
  ...c0d3  signup_bonus 500  balance_after 500  reference signup:...c0d3
           source handle_new_user  counterparty issuance:signup  issuance_class seeded

signup_errors for either user   0
supply_now         1031092.00
profiles_total_now 1031092        <- identity holds: one register row per player, no double count
```

P1's row is the whole path executed end to end by the trigger: the grant, the
journal with class `promotional`, the register row, and the incident. P3's
`seeded` row is the ON CONFLICT branch executed statement for statement with
`v_prev_diamonds = 500` substituted, because the branch itself cannot be fired
a second time: `on_auth_user_created` is `AFTER INSERT` and the id is a primary
key, so no second INSERT for the same user is possible. That substitution is
the one part of this lane demonstrated by executing the branch's SQL rather
than by firing the trigger, and it is called out here rather than glossed.

Note the register row for both users is `seed:`, not `signup:`: the
born-with-balance trigger runs during `handle_new_user`'s own profile INSERT,
so by the time the journal block runs the seed row exists and the signup
register row is correctly skipped. One row, 500, no double count. The journal
row is written either way.

`nextval('profiles_player_number_seq')` is not transactional, so the probes
consumed player numbers that no profile will use. That is the only trace they
left.

## What is log-only

The born-with-balance trigger. It records and returns; it never refuses a
profile INSERT. Dan's risk rule: a trigger that can raise on the first write of
a new player's life can lock every signup on the platform out. DR2's refusal
waits for Dan's word.

## What was NOT built, and why

- **No refusal of a balance-bearing profile INSERT.** Log-only first (above).
- **No backfill of the 416 unjournaled horses.** Rule 2 of the swarm brief:
  never move diamonds by migration. Their 500s are inside the acknowledged
  baseline, so the supply identity is square; what is missing is a per-user
  journal row for a grant that happened before the standard existed. Writing
  1,030,092 diamonds of invented history is worse than one honest baseline row.
- **`fn_ca_mint_velocity_watch` untouched.** Its live body reads
  `public.chip_ledger` over a 10-minute window filtered on
  `from_type IN ('system_mint','issuance_reserve')` and
  `to_type IN ('system_burn','chip_retirement')`. It never reads
  `ca_mint_ledger` and never looks at diamonds, so the baseline row cannot trip
  it and the `op_id LIKE 'baseline:%'` exclusion the brief anticipated is not
  needed. Adding it would have been dead code.
- **No `promo_budget` Mint destination.** Section 5's Lane B line mentions it,
  but `diamond_reward_budgets` is Lane E's table and its funding model is
  Lane E's design. A destination that writes a table another lane is still
  shaping would collide.
- **`fn_ca_mint_overview` untouched.** It reports supply and holdings and does
  not group by `holder_type`, so the new value needs nothing from it.

## Decisions that are Dan's

1. **When DR2 stops being log-only.** After a week of
   `DR2:balance_born_outside_the_mint` volume, the seeder and
   `ensure-profile.js` insert 0 and let the grant flow through the Mint
   (standard 3.2 Earn step 5), and the trigger becomes a refusal. That change
   is in the World Hub and in a seeder nobody has found yet.
2. **Where the seeder lives.** 416 profiles were created with a balance and no
   `signup_errors` row, which the FK says is only possible with the trigger
   suppressed. Until the seeder is found and read, the incident feed is the
   only instrument pointed at it.
3. **What the house is for first.** The account and both doors exist now and
   the balance is 0. Standard 3.2 wants it funding the Diamond Arena treasury,
   banking the trivia tournament cut (DR14) and paying guarantees. Nothing
   funds it yet, and nothing should until Dan says which of those is first.
