# Diamond Spins Maximum And Bonus Payout Audit

Owner direction: the maximum spin is 2,500 diamonds, with the optional Double
Down choice on every ordinary and Super bonus game. Scope is Deep Stack
Society's wheel and the four directly connected bonus games. No engine update.

The installed v4 source already accepts entries 25 through 2,500 and earned
bonus stakes through 7,500. The funding quote exposed a smaller maximum because the host's declared
backing was too small. The original rolled-back qualification proved a
5,000-diamond seed and 2,500-chip allowances for single spins. The later
owner request for complete prepaid 25-spin runs expands the backing needed:
the wheel seed is 125,000 diamonds, wheel exposure 62,500 chips,
and each bonus game's exposure 37,500 chips. The qualified configuration was
committed through the supported operator doors and read back at 09:34 UTC.
These are allocations against existing owner custody and host cover; the
owner's wallet and total host cover stayed unchanged. Installation, client
publication and final behavior proof remain separate entries in the checkpoint.

The maintained real PostgreSQL qualification now checks all sixteen maximum
v4 combinations: Plinko, Crash, Donkey Cross and Mines, ordinary and Super,
with and without the addon. It uses actual paid spins and bonus starters under
the authenticated role, proves the exact addon debit and receipt replay, and
rolls every money leg back. The same qualification script runs in required CI.
The shared bonus setup component also renders the maximum ordinary and Super
offer for each of the four games and verifies an explicit choice adds only
the original 2,500. Existing payout and wallet regression tests remain intact.

## Regular, Super And Double Down

Current bridge rate is 100 diamonds per chip. At an entry E:

| Award                     | Player Pays In Total | Game Stake | Guaranteed Minimum |
| ------------------------- | -------------------: | ---------: | -----------------: |
| Ordinary                  |                    E |          E |     Half The Stake |
| Ordinary With Double Down |                   2E |         2E |                  E |
| Super                     |                    E |         2E |                  E |
| Super With Double Down    |                   2E |         3E |                 2E |

At a 2,500-diamond spin these stakes are 25, 50, 50 and 75 chips; their
initial minimums are 12.50, 25, 25 and 50 chips. New Mines and Crossing
losses additionally retain at least half the last reached safe prize, rounded
up to a whole chip cent. Payouts are gross chip credits, not
profit. Super is an Upgrade-wheel award with a doubled house-funded base.
Double Down is one extra original entry, chosen before the game starts. Thus
the Super addon takes a 5,000 funded base to 7,500, not 10,000. Only the addon
is charged at bonus start. The initial spin was already charged.

New Mines and Crossing receipts carry payout version 5. Crash and Plinko
retain payout version 4. Older sealed rounds retain
their own rules. Floors are rounded up to chip cents and verified against
the authoritative receipt. The declared design return is 80% of the funded
game stake, rather than 80% of a Super player's own original spin. A larger
guarantee changes the risk distribution; it is not free additional payout on
top of the same odds. The primary wheel model, including Upgrade, is exactly
80% in its base law. No player is promised an 80% result over a short run.

## How Each Game Pays

- Crash: starts at a floor of 1.10x, cashout opens at 1.11x. A failed or
  uncashed flight pays its sealed minimum. For target x above 1.10x,
  survival probability is (0.8B - L)/(xB - L), where B is the funded chip
  stake and L its guaranteed minimum. Therefore the higher Super addon
  minimum reduces the probability of reaching a high cashout multiplier.
  Current configured maximum is 25x; a round's actual cap is sealed from its
  available backing. A surviving flight books automatically at that cap.
- Donkey Cross: one twelve-street road with multipliers 0.80, 1.45, 1.85,
  2.45, 3.15, 4.10, 5.35, 7, 9.10, 11.80, 15.40 and 20. The first street
  is certain. The player can bank after a successful crossing. A hit pays the greater of the initial minimum and half the last reached
  safe prize. For each next street, survival is (previous prize - current
  loss floor)/(next prize - current loss floor). The cumulative survival is
  the product of these conditional chances. More generous loss retention
  changes those chances rather than creating extra expected payouts.
- Mines: 25 tiles, six mines; the first pick is always safe and pays 0.80B.
  After n safe picks, the next tile's mine chance is 6/(25-n). The new ladder
  preserves the previous prize's expected value: next prize = (previous
  prize - mine chance × current loss floor)/safe chance. A mine pays at least
  half the last safe prize. The sealed quote decides the final allowed pick
  count. Historical version4 boards retain their original fixed-floor ladder.
- Plinko: sixteen rows, seventeen slots. Every drop's slot k has probability
  C(16,k)/65,536. The player chooses an allowed drop value dividing the whole
  stake into one to one hundred drops; all diamonds must be played. The table
  follows the minimum: table 4 for the half-stake floor, table 6 for Super
  with Double Down. Table 4's lowest slot is 0.52x and top is 20x; table 6's
  lowest is 0.72x and top is 20x. Both have exact 80% weighted return.
  More drops smooth the total toward its mean and make large total wins
  rarer. A slot's 20x label is a multiplier on one drop, not a 20x multiplier
  on a whole run whose other drops landed elsewhere.

The table called Super in Plinko is also used by ordinary awards because its
lowest slot carries the required half-stake minimum. Its table name alone
does not identify a Super wheel award.

## Mini, Minor, Major And Grand

These are instant chip prizes on the Upgrade wheel, not progressive pools.
Their amount is the original spin's chip value times their multiplier.
Double Down is offered only for a bonus game and does not alter these prizes.

| Prize | Multiplier | Chips On A 2,500 Spin | Odds Within Upgrade |
| ----- | ---------: | --------------------: | ------------------: |
| Mini  |         5x |                   125 |                9.6% |
| Minor |        10x |                   250 |                7.4% |
| Major |        25x |                   625 |                  2% |
| Grand |       100x |                 2,500 |                  1% |

The remaining 80% of the Upgrade table awards one of the four Super games,
20% each in its base table. Upgrade itself has 1% base weight on the main
wheel. Corresponding overall base-law prize weights are Mini 0.096%, Minor
0.074%, Major 0.02% and Grand 0.01%. Spins are not independent: the v4
follow-up matrix excludes the last prize and the last bonus game across tiers.
The receipt names the weights actually used; those conditional odds can
differ from base weights. The four instant Upgrade prize weights remain
unchanged when a repeated game is excluded.

Chip prizes credit the player's club chip balance through the canonical
Promo-first payer with the host bank as backup, with idempotent journal keys.
Diamond card prizes instead seal half/double/triple the entry and pay the one
chosen card once from owner custody and wheel float. Host funding includes
the Grand prize, every possible doubled bonus, and unpicked diamond cards.
Outstanding liabilities and platform freezes still prevent unfunded play.

## Complete Paid Runs And Prize Order

The client publishes every independent server-seed hash before paying for a
5/10/25-spin run. One authenticated transaction then executes every canonical
v4 spin, including each entry journal, prize and earned game reservation.
Every selected spin commits, or the transaction rolls back with zero charge.
A lost reply replays the same immutable batch receipt. The client presents
those receipts in order, without placing another wager.

Batch game awards reserve the full 20x maximum optional-addon stake rather
than consuming nearly all available exposure on the first won game. Their
sealed base cap is 40x for ordinary or 30x for Super; with Double Down the
final funded stake's cap is 20x. An undoubled Crash still observes its 25x
configured ceiling, Crossing its 20x final street and Plinko its approved
20x table. Mines' pick limit follows that exact sealed cap. Single spins and
historical awards keep their previous funded caps. No prize weights change.

Not Now continues the receipt presentation and saves the bonus game. Play
Next Saved Game opens the earliest unplayed game or card; an explicit saved
return intent resumes the remaining paid receipts after completion. Completed
batch receipts survive reload, with the browser retaining the last presented
position. Ending the presentation still reports every completed paid spin.
Fresh game starts and card picks enforce one combined FIFO queue at the
server, including an explicit per-spin index for transactions whose award
timestamps are identical. Completed request replays remain idempotent.

The lower console removes Refresh Wheel and prioritizes the amount, balances,
run selection and illuminated Spin plate. Lifetime averages use recorded
nonfixture completed games with sample counts and explicit definitions;
conditional next-move odds come from the sealed game, not those averages.
The hosted browser gate caught the odds text pushing the choice-game plates
off a 375-by-667 phone. A dedicated compact risk readout and scene height
budget now keep the board, odds, loss floor and both plates on that screen;
the maintained browser test checks the risk text as well as the controls.
