# Phase 8, part 2: round 3, and the transfer the trial balance cannot see

2026-09-08. Club Arena. One migration, five more pins on the phase 8 law.

## What this finishes

`20260908113416` put round 2 and the agent claim onto `chip_ledger`. That
covered the payers the trial balance would have caught. This is the sweep of
what was left, asking each remaining union money path the same two questions:
does it move a balance, and does it write a leg.

| function                             | moves a balance | writes a leg |
| ------------------------------------ | --------------- | ------------ |
| `fn_settle_round3_agents_to_players` | **yes**         | **no**       |
| `fn_union_eco_adjustment`            | no              | n/a          |
| `fn_union_eco_record`                | no              | n/a          |
| `fn_union_weekly_statement`          | no              | n/a          |
| `fn_union_weekly_agent_statements`   | no              | n/a          |

The four eco and statement functions compute and report; they move nothing, so
they correctly need no leg. Round 3 was the one real gap left.

## The gap

Round 3 debits the agent's `club_members.chip_balance`, credits the player's,
marks the `rakeback_periods` row paid, and writes a single one-sided
`wallet_transactions` row. No journal entry.

It has run: **559 rows totalling 43,990.40 on 2026-08-20**, none with anything
in the journal behind them.

## Why no reader caught it, which is the part worth keeping

Both sides of round 3 are `club_members.chip_balance`. The supply snapshot
calls that `member_wallets` and `fn_ca_trial_balance` reports it as the single
account `player_wallets`. So the debit and the credit **cancel inside one
account** and the account total never moves.

The trial balance is therefore structurally blind to an agent-to-player
transfer, at any size. It is not that it happened to be quiet - it cannot see
this shape at all.

`fn_ca_ledger_replay` can: it works per account OWNER, so it would find the
agent's balance down and the player's up with no journal net either side.
Feeding that reader is exactly what Phase 8 is for, and it is the reason a leg
nothing else can check is still worth writing.

## Dormant, not dead, which is why it was cheap to fix today

Measured 2026-09-08:

```
pending rakeback rows                                  2,766   worth 325,960.71
club members carrying an agent_id                      1,575
pending rakeback whose player has an agent AND
  whose club is in a union  (what round 3 pays on)         0
```

Round 3 has nothing to pay right now. The moment that intersection is non-empty
it pays again - and now it pays onto the journal.

## The leg

`player_wallet -> player_wallet`, because both sides genuinely are member
wallets; a same-type leg is already ordinary here (`prize_liability ->
prize_liability`, 582 legs in two days). Category `rakeback`, not `commission`,
so a reader can still tell the two obligations apart. Keyed
`round3:<union>:<period start>:<club>:<agent>:<player>` against
`ux_chip_ledger_idempotency_key`, `ON CONFLICT DO NOTHING`.

## Proved on production, rolled back

No union has an eligible pair today, so the probe built one - a club in a union,
one member made the other's agent, one pending rakeback row - applied the
transform, and ran the real function:

```
round 3 result   payees 1, amount 25.00, shortfalls 0
agent    500.00 -> 475.00             (delta -25.00)
player   615,200.75 -> 615,225.75     (delta +25.00)
journal  1 leg, sum 25.00
```

The leg equals the movement, on both sides, to the cent. All of it rolled back
by the probe's own `RAISE`.

One thing the fixture taught, worth writing down: `club_members.agent_id` is a
foreign key to `profiles`, so it holds the agent's USER id, not a row id from
`agents`. Setting it from `agents.id` fails the constraint.

## The law

`tests/a-commission-payment-is-on-the-journal.law.test.ts` gains five pins for
round 3: it posts to the journal, names member wallets on both sides, is
`rakeback` and not `commission`, is keyed with `ON CONFLICT DO NOTHING`, and
refuses to guess while keeping every step it already had. Fourteen pins now
cover all three payers.
