# Promo: one door open, four shut, and a phantom retired

2026-09-03/04, on Dan's rulings after the pre-Phase-3 sweep.

> "WE'VE NEVER BUILT THE SPLASH POT YET, OR DESIGNED RULES FOR IT, ITS SUPPOSED
> TO BE ADDED LATER, ONCE WE WORK ALL THE BUGS OUT."
>
> "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX THIS ALL AND MAKE
> IT SO ITS IMPOSSIBLE TO EVER LOSE A CHIP, OR NOT HAVE EVERY SINGLE CHIP
> ACCOUNTED FOR AND ACCOUNTABLE. THATS THE GOAL!"
>
> "FIX ALL OF THESE FULLY SO WE CAN MOVE ON, YOU DECIDE HOW THEY NEED TO BE
> BUILT AND FIXED."

## 1. The splash pot is shut, and my earlier fix was the wrong call

An hour before this, I found `fn_bbj_promo_rain` broken in three ways and fixed
all three. Dan's ruling: the splash pot was never built or specified, and is to
be added later. So my fix turned an **undesigned** money path into a **working**
one - an owner could have emptied a union's promo float across 413 seats in one
click, against rules that do not exist.

The door is shut at the top and only at the top. `fn_bbj_promo_rain` refuses
every call with `not_built_yet`, names the sanctioned path, and loses its
`authenticated` grant so no browser reaches it. The accounting beneath it
(`fn_bbj_promo_payout_atomic`) keeps its corrections - it draws on the float the
sweep fills, credits ordinary chips per ruling 4B, declares its counterparty -
so when the splash pot is designed, the work left is rules, not plumbing.

Nothing is lost: zero rains have ever paid.

## 2. The 10,700 was not an inert seed. It had a source.

`wallets(wallet_type='PROMO')` held **10,700.00 across 107 holders in 447 rows**.
I had reported it as a January seed. The sweep found the writer:
`create_user_wallets`, a signup function handing every new account a 100-chip
"welcome bonus" into that pool, plus 1,000 phantom player chips. Its trigger was
detached at some point - which is why the last row is dated 2026-01-24 - but the
**function survived**, ready to seed phantoms again if anything re-attached it.

No function in the database reads that pool. `fn_ca_supply_snapshot` has never
counted it. Those chips have never existed inside the measured supply.

**Retired as a write-off, deliberately not as a burn.** A burn row would tell the
chip meter that 10,700 real chips left circulation. They never entered it, so a
burn would have invented 10,700 of issuance error in the very accounts this
programme exists to make exact. The balances are zeroed, an audit row records
what and why, and `chip_ledger` is untouched. The supply meter's unexplained
figure for the interval was **0.00**.

Two guards refused the work first, and both were right:

- `chip_escrow_holds_wallet_id_fkey` refused a DELETE - 40 legacy escrow holds
  from 2026-08-15/16 (715,000 chips of them) still point at PROMO wallet rows.
  `chip_escrow_holds` is already on the Phase 3 retirement list, so the rows are
  zeroed and kept rather than deleted.
- `guard_wallet_balance_write` refused a direct balance write and named its own
  override. That guard exists to stop exactly this shape of write; the only
  reason it is legitimate here is that the balance is not money. So the override
  is set for one statement and cleared, the same discipline as the append-only
  door used for the certification fixtures - and the self-check fails if it is
  left open.

## 3. Four unfunded doors, shut

| door                           | what it did                                                                                                              | now                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `add_to_promo_wallet`          | wrote the phantom pool; called by PromotionService (deposit bonus, referral bonus) and AchievementService (chip rewards) | refuses, names `fn_promo_disburse`     |
| `distribute_promo_chips`       | debited `agents.promo_balance`, a column no sweep maintains (0.00 estate-wide)                                           | refuses                                |
| `transfer_promo_club_to_agent` | credited a member's locked promo bucket                                                                                  | refuses                                |
| `create_user_wallets`          | seeded phantom wallets on signup                                                                                         | inert, kept so re-attaching is a no-op |

A deposit bonus, a referral bonus and an achievement reward are real product
promises - but none has a funded source, and inventing one here would be the
unfunded mint this programme has spent two phases removing. They pay nothing
today, because the pool is unspendable, so refusing changes no player's position
and stops the pretence. When those programmes are designed and funded,
`fn_promo_disburse` is the door.

## 4. The owner's door now has a button

`fn_promo_disburse` was built and proven but nothing called it. `WalletService`
gains `disbursePromo(clubId, playerId, amount, note?)`, which resolves who owns
the float - the union when the club is in one, the club itself when it is not -
and calls the sanctioned RPC. The database refuses anyone who is not that owner.

Both live call sites now use it, and each loses the `agents` primary-key lookup
the retired path needed:

- `AgentDashboardPage` - the club dashboard's promo grant
- `PlayerSessionsPage` - the win-back button

`distributePromo` remains only as a throwing stub so nothing reaches the retired
path by accident, and `bulkDistributePromo` routes through the club door.

## Verification

- Full suite on this branch: **12,515 passed / 907 files**. `tsc --noEmit`: clean.
- The discarded-error-read ratchet caught the improvement and its baseline for
  `PlayerSessionsPage.tsx` was tightened 3 -> 2, as that gate requires.
- Production after the retirement: `wallets(PROMO)` total **0.00**, 447 row
  skeletons kept, supply meter unexplained for the interval **0.00**.

## Files

- `supabase/migrations/20260903233924_the_splash_pot_is_not_designed_yet_so_its_door_is_shut.sql`
- `supabase/migrations/20260903234327_the_phantom_promo_pool_is_retired_and_its_doors_are_shut.sql`
- `src/services/WalletService.ts`, `src/pages/AgentDashboardPage.tsx`, `src/pages/PlayerSessionsPage.tsx`
- `tests/promo-is-owner-money-and-nothing-else-pays-it.law.test.ts`
- `tests/unit/WalletService.test.ts`, `tests/unit/discardedErrorReadRatchet.test.ts`
