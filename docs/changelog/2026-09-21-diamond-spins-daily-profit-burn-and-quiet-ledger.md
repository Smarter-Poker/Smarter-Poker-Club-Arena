# Diamond Spins: the daily settlement burns 20% of a profitable day, and every prize is ledger only (2026-09-21)

Owner rulings 2026-09-21, R14, R16 and R17. Migrations `20260921202827`
(quiet ledger) and `20260921202834` (daily profit burn). Branch
`agent/cowork-dspins/d3-settle`.

## Behaviour

**R14, the burn.** A club or union owner still receives the day's Diamond Spins
profit once a day in ONE wallet transaction (`fn_diamond_spin_settle_day`,
unchanged shape since 20260919152614). On a day whose net is positive the
platform now burns 20% of that net and the owner is credited the remaining 80%:

```
net      = entries + Double Down + Mint entries - diamond prizes - throwables - time banks - rabbit hunts
burn     = floor(net * 2000 / 10000)      whole diamonds, never more than 20%, 0 when net <= 0
credited = net - burn                      the one 'transfer' row, reference diamond-spin-day:<owner>:<day>
```

The rate lives in one function, `fn_diamond_spin_profit_burn_bps()` (2000), and
the arithmetic in one, `fn_diamond_spin_profit_burn(net, bps)`. The burn is
booked the way the estate already retires custody supply for consumed inventory
(20260919152614:160-170): one `ca_mint_ledger` row, action `burn`, asset
`diamonds`, holder `player` = the owner, op_id `diamond-spin-burn:<owner>:<day>`
(UNIQUE). The day row records `profit_burn_bps`, `profit_burn` and
`credited_net` (generated as `settled_net - profit_burn`) under a CHECK that ties
the burn to the rate the day recorded, and the deferred receipt trigger proves at
commit that the wallet row equals `credited_net`, that exactly one burn row of
exactly `profit_burn` exists when it should and none when it should not, that
the rate applied is the current rate, and that the statement notification
carries all three figures and cannot push.

Zero and negative days settle exactly as before (no burn; a negative net is
paid from the owner wallet). Re-running a settled day replays its receipt and
writes nothing. The two-connection race still yields exactly one transfer, and
now exactly one burn row.

**No retroactive burn.** Days settled before the migration keep `profit_burn 0`,
`profit_burn_bps 0`, `credited_net = settled_net` through column defaults; no
settled row is updated (the immutability trigger has nothing to refuse). Read
from production before writing: one settled day (2026-09-20, net 12,400, paid
in full) and one open day (2026-09-21). The harness installs the migration over
a database holding exactly that shape and proves both rows are untouched, then
settles the formerly open day with the burn.

**Owner facing.** The daily statement (`fn_diamond_spin_statements`,
`DiamondSpinStatements`) shows three lines: Net Diamonds Earned, Platform Burn
(20%), Credited To Your Wallet. An open day shows the net and "Settles After
Midnight" for the other two. The service validator refuses a statement whose
lines do not add up at the rate the day recorded.

**Owner terms.** The play gate keys on the literal receipt
`diamond-spins-2026-09-14-v1` in three functions (`fn_diamond_spins_owner_agreed`,
`fn_wheel_spin_v2`/`_state_v2` through it, and an inline check inside
`fn_diamond_game_admit`). Bumping that literal would switch every host OFF until
its owner taps accept: an outage, not a consent flow. So the gate is untouched
and the burn is published as a second, immutable receipt: version
`diamond-spins-2026-09-21-v2` is a dated addendum to the base agreement.
`fn_diamond_spins_owner_terms` returns the base agreement and the addendum with
their own `accepted` flags; `p_agree` records the addendum for an owner who
already holds the base receipt, and records both for a new host owner who reads
both texts. The burn applies to every day settled after installation whether or
not the addendum has been acknowledged, and the addendum text says so. The UI
(`DiamondSpinsOwnerTerms`) shows the notice with an "Acknowledge Notice" action
for existing hosts and "Accept Agreement" for new ones.

**R17, quiet ledger.** No push notification, inbox notification, Messenger
invoice or per-transaction accounting document is generated for a Diamond Spins
movement, for the player or for the host roster. Root cause: trigger
`accounting_transfer_document` on `chip_ledger` (20260914113214) fired on every
posted leg from a union wallet, union bank or club treasury into a player
wallet, and 20260914121645 had deliberately taught the invoice writer the five
game categories. That 2026-09-14 ruling is reversed for these categories: the
trigger's WHEN clause now excludes `fn_diamond_spin_ledger_category(NEW.category)`
(`wheel_prize`, `plinko_prize`, `crash_prize`, `crossing_prize`, `mines_prize`),
one function read by the predicate and by the probes, so a category added for a
new Diamond Spins game (the Diamonds card game, R15) goes there and nowhere
else. Every ledger row is kept exactly as before: `chip_ledger`,
`chip_transactions`, `union_wallet_transactions`, `diamond_transactions`, custody
movements. The trigger is re-declared in `ca_declared_money_triggers`. Documents
already issued are immutable and stay.

The once-a-day settlement notification stays (the day row requires it) but
carries `'_push':'ledger_only'`, the key `fn_mirror_notification_to_push_outbox`
already honours, so it never reaches `push_outbox`; the receipt trigger refuses
a settlement that pushed.

## The latent defect the same line closes

`20260921052548` gates `fn_accounting_party_users` so a browser caller sees a
roster only when it is itself on it. A wheel spin is an authenticated browser
RPC. For a union host's prize the deliverer needs BOTH rosters, and no
authenticated session is on both (the player is not on the issuer roster, the
owner is not the payee), so `fn_deliver_accounting_invoice` raises
`accounting_invoice_recipient_missing` and the whole prize transaction aborts.
Reproduced in the fixture (`diamond-spins-quiet-ledger-before.sql`: player
refused, owner refused, engine identity documents) and proved gone after the
exclusion (`diamond-spins-quiet-ledger.sql`). Read from production 2026-09-21:
`20260921052548` is merged but NOT yet installed, so this is latent. Install
`20260921202827` with or before it, never after it alone.

## Proof

`scripts/dev/test-accounting-delivery.sh` (PostgreSQL 17 fixture, every probe
rolled back, every public/auth row compared), exit 0:

- `tests/sql/diamond-spins-quiet-ledger-before.sql` (pre-migration reproduction)
- `tests/sql/diamond-spins-quiet-ledger.sql` (five categories, union and club,
  promo and bank legs, player and owner paid, zero documents; a non-Diamond leg
  still documents)
- `tests/sql/diamond-games-bank-fallback.sql` (pins moved: no document per bank leg)
- `tests/fixtures/accounting-delivery/diamond-games/daily-burn-legacy-*.sql`
  (installation over a pre-burn settled day and an open day)
- `tests/sql/diamond-spins-daily-profit-burn.sql` (210 net burns 42 credits 168;
  negative, odd, tiny and zero days; supply identity and
  `fn_ca_diamond_trial_balance` before and after; replay; burn failure rolls
  back; quiet notice, no push; three statement lines; addendum receipts)
- `tests/sql/diamond-spins-every-movement-has-a-ledger-row.sql` (R16: one paid
  spin per prize kind the live model produces, both hosts; found no path that
  pays or debits without a record)
- the two-connection settlement race, now on the burn contract
  (`daily-custody-concurrency-assert.sql`: one transfer of 80, one burn of 20,
  one quiet notification, no push)

Client: `tests/unit/diamondStatementService.test.ts`,
`tests/components/DiamondSpinStatements.test.tsx`,
`tests/components/DiamondSpinsOwnerTerms.test.tsx`,
`tests/unit/whereTheDiamondsGo.test.ts` (the burn adds no wallet kind).

## Left as found, reported

- `fn_diamond_spin_settle_daily` still settles every owner in one transaction:
  one owner's failure rolls back every owner's settlement. Not touched here (not
  the function the burn lives in, and isolating it needs an observable failure
  path, not a swallowed one).
- `fn_diamond_game_admit` carries the inline `diamond-spins-2026-09-14-v1`
  literal; it should read `fn_diamond_spins_owner_agreed` like the wheel does.
- The game-category branch inside `fn_invoice_accounting_ledger_transfer`
  (20260914124421) is now unreachable from the trigger and left in place.
