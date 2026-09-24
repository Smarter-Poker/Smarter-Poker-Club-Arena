# The Crash odds a player reads are the odds the server plays

2026-09-22, after the Diamond Crash fairness audit.

## What the audit found

The game is fair. Sixteen of sixteen production rounds recompute from their
revealed seeds, with no mismatch, and the sealed draw reaches its designed
outcomes at its designed rate (`tests/sql/diamond-bonus-fairness-audit.sql`).

What was not true was what the lobby said about it.

- **The odds.** `src/pages/DiamondGamesPage.tsx` printed "Instant Crash 1 In 5".
  That was the no-minimum game. Migration `20260919034436` made every round fund
  a guaranteed minimum `L` (a share of its own stake) out of its odds: the crash
  point became `X = L + (0.8 - L) / u`, so `P(X >= x) = (0.8 - L) / (x - L)` and
  an instant crash - the round dies at 1.00x, below the first hundredth a
  cash-out can bind - went from 1 in 4.8 to **1 in 4.2 to 4.3 on an ordinary
  award** and **1 in 2.4 on a Super award**. Since the wheel-award release every
  live round has one of those two minimums.
- **The cap.** "Up To 100x Per Round" was `config.max_multiplier_cents`, the
  configured ceiling. A round's cap comes from the award it starts from
  (`fn_diamond_game_cap_cents` scales the award's cap by base over total), 20x to
  100x in practice.
- **The verifier.** `verifyCrashRound` defaulted the bet to 1 and the minimum to
  0, so a third party following those defaults recomputed the retired game and
  disagreed with four of six award rounds. Three source comments described the
  same retired game.
- **The lock.** `fn_diamond_game_append_only` protected only
  `minimum_payout_chips` while a crash round was open: `crash_cents`, `roll`,
  `server_seed`, `client_seed`, `nonce`, `started_at`, `cap_cents`, `growth_k`,
  `auto_cashout_cents` and `bet_chips` could have been rewritten under a round in
  play, and `diamond_game_commits` had no trigger at all. Donkey Cross and Mines
  rounds have been locked since `20260914102113`. Nothing rewrites them today.
- **The console.** `fn_diamond_game_quote_max` still priced the retired mine
  counts and road ladders, so the owner's max win, intake and ceiling figures
  came from games nobody can play.

## What changed

- The lobby computes every crash figure: the odds from the server's own minimum
  rule across every stake a wheel award can be played at
  (`awardInstantCrashChances`, `oneInRangeLabel` in
  `src/utils/diamondGamesFairness.ts`), the cap from the bets the server quotes.
  A figure with nothing behind it is not shown at all.
- `crashPointCentsFromRoll` and `verifyCrashRound` require the round's bet and
  minimum, and refuse a call that omits them.
- Migration `20260922173914` gives `crash_rounds` and `diamond_game_commits` the
  lock Donkey Cross rounds have: a round still open may move only the settlement
  columns `fn_crash_decide` writes, and only to `cashed` or `crashed`; a ticket is
  spent once and deleted only by the expired-unused sweep; the
  `app.ledger_maintenance` escape and the minimum rule are unchanged.
- Migration `20260922173916` makes `fn_diamond_game_quote_max` price the one
  setting `fn_choice_mode` names. At the 50-chip top bet the console's Mines max
  win moves from 1,449.88 to 1,243.47 chips and Donkey Cross from 1,200.00 to
  1,000.00; the ceiling figures move from 7,384.17 and 12,800.00 to 6,713.34 and
  1,000.00. No payout, price, cap or odds changed - only what the console quotes.

## How it was proved

- `tests/unit/diamondGamesFairness.test.ts`: the odds function against the
  audit's figures at L = 0, a tenth and a half, and against the exact count of
  rolls the sealed crash point puts below each target.
- `tests/components/DiamondGamesLobbyOdds.test.tsx`: the rendered lobby.
- `tests/the-crash-odds-are-the-odds-the-server-plays.law.test.ts`: the figures
  stay derived, the verifier stays required, the lock stays in the migration.
- Production, before applying: one self-aborting call built the new function in
  `pg_temp` over temporary copies of both tables holding copies of real rows.
- The isolated accounting fixture (`scripts/dev/test-accounting-delivery.sh`)
  runs the real cash-out, auto, cap, tick and time settlements and the four
  award starts that spend a ticket on top of the lock, then
  `tests/sql/diamond-crash-round-is-sealed.sql` proves the refusals.
