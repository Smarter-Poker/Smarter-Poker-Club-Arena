# The overdue agent commission is paid (2026-10-03)

Follows section 1 of `2026-10-03-launch-money-and-alert-hygiene.md`. Owner
direction (Dan, relayed 2026-10-03): "pay it how you feel it's necessary";
CLAUDE.md 10.9.

## What was owed

`agent_commission_unsettled_rollup` read 2,361,330.13 across 239 (club, agent)
pairs. The open week (2026-09-28 07:00Z -> 10-05) is paid by its own close
and is not touched. The rest, measured per club and week from the recorded
rows:

| club               |      overdue | weeks                                   |
| ------------------ | -----------: | --------------------------------------- |
| Deep Stack Society |   560,017.06 | 08-31, 09-07                            |
| SHARK CLUB         |   485,808.88 | 04-27 .. 06-08, 07-13 .. 08-24, 09-14   |
| Club JAQK          |   113,695.75 | 04-27, 07-20 .. 08-24, 09-14            |
| Midway Union       |     3,243.59 | 08-17 .. 09-14 (the union's house club) |
| total              | 1,162,765.28 | ~3.6M rows                              |

Nothing could pay it: the weekly close refuses weeks below its floor, the
agent claim is retired, and the legacy discharge only accepts weeks recorded in
`accounting_deferred_obligations`, which these are not.

## Decision

- **Basis: the recorded rows.** The weekly close pays an agent the exact sum of
  his recorded rows for the period (kingfish, SHARK CLUB, week 09-21: 3,757
  rows, 825.74 summed and settled), and Dan ruled on 2026-09-01 that the legacy
  commission rows are paid "FROM THE CLUB BANK".
- **Horses are paid, not waived.** 236 of the 239 pairs are horses. CLAUDE.md
  10.5 ("Never 'skip the horses' on a repayment"), Dan's 2026-09-26 reversal
  of the 09-14 week closed "without payment because every recipient is a house
  horse", and operation 19aa02d6, which paid 784,513.37 of that week's
  commission to horse agents.
- **Funding.** Club JAQK, SHARK CLUB and the union's house club held 44.76,
  11,120.68 and 0.02. The union never closed those weeks, so their share of the
  rake is still in the union rake treasury, which funds each club exactly what it
  pays (602,748.22). Deep Stack Society's rake of its two weeks was credited to
  its treasury at the hand and spent since; its treasury (638,780.09) has to
  carry the 10-05 close, so the house funds it by exactly its payment through
  `fn_ca_fund_club` (560,017.06), as `20261002092328` did for its 09-14 share.
- **kingfish** (the one human) is paid 3,556.42: JAQK 13.00, SHARK 3,460.51,
  Midway 82.91. His 4,973.74 of the open week stays with the 10-05 close.
- 79 pairs (3,119.47) have no wallet in the club that recorded the commission;
  as in operation e5b10b0a they are paid into their wallet in a union member
  club. The leg names the recording club.

## Migrations

- `20261003092151` pays it once (operation `c419b506-79a3-465a-99ba-adca6e0e5c2e`):
  one `club_treasury -> player_wallet` commission leg per pair with its wallet
  credit and receipt (invoice, Messenger record, notification), the union and
  mint funding legs, and one `agent_commission_settlements` row per (pair,
  week) spanning exactly the paid rows (ref `owner_legacy_commission:c419b506-...`).
  It asserts the measured figures, conservation on the balances and the
  commit-time ledger checks, and refuses a replay.
- `20261003092205` brings the rollup down by exactly what was settled, under
  the live writers' per-club commission keys.
- `20261003092217` is the root fix: a settlement floor can no longer be moved
  above recorded agent commission that is unsettled and uncovered. Every floor
  move so far recorded the rakeback it skipped and none looked at commission.

## Probe

Rolled back in production at 09:32Z on a subset (kingfish's three clubs, two
Deep Stack Society agents, two Midway agents without a Midway wallet, one JAQK
horse): 8 legs, 9,716.01, 20 settlement periods, 3 payees outside the recording
club, Deep Stack funding minted and union funding debited, commit-time ledger
checks run with `SET CONSTRAINTS ALL IMMEDIATE`: PROBE OK. The full plan was
read separately per club and matches the figures above.
