# 2026-10-24 - Transaction History: type and date filters, an agent's downline book, true totals (database)

Dan, 2026-10-24: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE", on the
Transaction History follow-ups. This is the database half; the client that uses
it ships separately once this is installed.

## What it adds

- `fn_cashier_history_page(club, scope, kind, from, to, limit, offset)`. The
  server decides the book and can only narrow it: the club book for owner,
  co-owner and admin; the downline book (own rows plus every active cashier
  downline member's) for super agent, agent and sub agent, per Dan's Club Data
  ruling that agents see their own plus their downlines; otherwise the
  viewer's own rows. `kind` is `cashout` (the five cash-out legs), `transfer`
  (wallet, bank, promo, union, treasury and ticket moves, including a
  treasury-funded seat, which is presented as a Club Bank send) or `game`
  (everything else: table cash-outs, tournament buy-ins, prizes).
- `fn_cashier_history_totals(club, kind, from, to)`. In, Out and Net of the
  viewer's own wallet over the whole filtered book, by the Full Statement's
  direction rule.
- `idx_chip_tx_club_transfer_created`, a partial index on exactly the transfer
  kinds, built CONCURRENTLY.

## Measured on production before shipping (KINGS CLUB, 981k rows)

| query                                          | before                     | after                          |
| ---------------------------------------------- | -------------------------- | ------------------------------ |
| club book, Transfers, newest 251               | 7.7 s (107k rows filtered) | partial index (ordered scan)   |
| agent downline book (33 rows)                  | 13.9 s (club-wide OR scan) | 92 ms (per-person index merge) |
| 25 heaviest accounts as a downline, offset 200 | -                          | ~2.0 s worst case              |
| own-wallet totals, any filter                  | -                          | 1-18 ms                        |
| club-wide totals, 30 days                      | 34 s                       | not offered (deliberately)     |

Scope matrix read back for owner, agent and player: a non-staff request for
the club book and a non-agent request for a downline both return the viewer's
own rows; the agent's downline book includes his players' rows.

Pinned by `tests/the-cashier-history-filters.law.test.ts`.
