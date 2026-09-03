# Club money ledgers — canonical model (2026-07-21)

Status: AUTHORITATIVE. Read before touching any club-money code or "reconciling"
`clubs.chip_treasury`, `clubs.chip_pool`, or `club_wallets.chip_balance`.

## TL;DR — these are THREE DISTINCT LEDGERS, not three copies of one balance

An earlier audit item framed this as "three duplicate club money stores — pick a
canonical one and collapse the rest." That premise is WRONG and acting on it would
destroy real chips. Verified live 2026-07-21 (Club JAQK: treasury 2.60M / pool 12.5K /
club_wallet 14.25; SHARK: treasury 786K / pool 0 / club_wallet 184K; union rake_wallet
244K). The three stores hold different amounts because they track different things.

| Store                                                    | Canonical role                                                                                                                                    | Credited by                                                                                                                                                        | Debited by                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clubs.chip_treasury`                                    | **Operational bank** — the spendable club bankroll                                                                                                | rake for STANDALONE clubs (via `increment_club_chip_pool` — see naming trap), `fn_credit_treasury`, leave-club (`fn_member_leave_to_treasury`), union send-to-club | horse seat/fund (`fn_horse_seat_from_treasury`/`fn_horse_fund_from_treasury`), cashouts (`fn_approve_cashout_atomic`), `decrement_club_treasury`/`fn_debit_treasury`, union clawback |
| `clubs.chip_pool`                                        | **Mint-and-distribute ledger** — minted chips awaiting handout to members                                                                         | `mint_club_chips`                                                                                                                                                  | `distribute_chips` (agent hands chips to a member -> `club_members.chip_balance`)                                                                                                    |
| `club_wallets.chip_balance` (+ period/lifetime counters) | **Rake accounting / dashboard counter + settlement basis** — always credited for EVERY rake event regardless of where the chips physically settle | `credit_club_wallet_rake`, `record_rake`, commission/insurance/tournament-rake fns                                                                                 | commission payout / settlement draw-down (settlement runner)                                                                                                                         |

## The rake flow (authoritative — from engine `logRakeCollection`)

For every raked hand the engine does TWO things, in order:

1. ALWAYS `credit_club_wallet_rake` -> `club_wallets.chip_balance += (rake - bbj)` plus
   period/lifetime counters + an audit row. This is the **accounting counter**
   (Round 42 fix — pre-fix it stayed at 0 for every club). It is credited whether the
   club is standalone or in a union.
2. THEN the chips physically settle to exactly ONE place:
   - **Union club** (`clubs.union_id` set, e.g. SHARK CLUB): rake -> `union_wallets.rake_wallet`
     (held until weekly union settlement). The club's own `chip_treasury` is NOT credited.
   - **Standalone club** (`union_id` null, e.g. Club JAQK): rake -> `chip_treasury`
     via `increment_club_chip_pool`.

BBJ contribution is split off into `bbj_pools` separately (never in treasury).

## Naming traps (do NOT "fix" the balances because a name misled you)

- `increment_club_chip_pool(p_club_id, p_amount)` writes **`chip_treasury`** (+ `total_rake`),
  NOT `chip_pool`. The name is a legacy misnomer. It is the standalone-club rake->bank path.
- `distribute_chips` uses local variables named `v_treasury_*` but reads/writes **`chip_pool`**.
- `club_wallets.chip_balance` sounds like a spendable wallet but for a STANDALONE club it is
  an **accounting mirror** of rake, running in parallel with `chip_treasury` (the real bank).

## Conservation status (verified 2026-07-21)

No active chip-conservation bug in the CURRENT code path: each rake event credits the
accounting counter once and settles the actual chips to exactly one spendable location
(union wallet XOR chip_treasury). The divergent balances are largely HISTORICAL
(pre-Round-42 `club_wallets` under-counting), not a live leak. Moving/merging balances now
would corrupt the ledgers and is explicitly out of scope.

## CONSTRAINT for the settlement/commission runner (tasks: settlement build-out)

For a STANDALONE club, rake lands in BOTH `chip_treasury` (operational) and
`club_wallets.chip_balance` (accounting mirror). These are NOT two independent pots of
real chips. When the weekly settlement / commission payout runner is built it MUST treat
`club_wallets.chip_balance` as the accounting **basis** for what to pay, and draw the
actual chips from ONE canonical source (the operational bank / union wallet) — it must not
pay commissions out of `chip_treasury` AND separately draw down `club_wallets.chip_balance`
as if both were spendable, or it will double-spend rake. (Today the settlement runner is
not live end-to-end, so no double-spend is occurring — but this is the rule to honor.)

## If Dan wants a single unified balance

That is a deliberate, separate migration with real-money consequences (moving millions of
chips between ledgers, rewriting ~20 functions and the engine rake path, and redefining the
settlement basis). It requires explicit sign-off and a written rollback. It is NOT a
"cleanup" and must not be done implicitly. Default: keep the three-ledger model above.
