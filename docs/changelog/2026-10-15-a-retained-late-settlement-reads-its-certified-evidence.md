# A Retained Late Settlement Reads Its Certified Evidence (2026-10-15)

## What happened

The original week (union fade0000, 2026-10-05 to 10-12) proved all 84 flow windows at 12:16 UTC and assembled `pnl_flows_problem` with 22 invalid flows. The union report then answers `original_money_flow_basis_incomplete`, so the week cannot close. The certificate of 2026-10-14 12:13 had read the same week with no invalid flow.

## The 22 flows

The 22 are late seat settlements written between 15:33:05 and 15:34:17 UTC on 2026-10-06:

- `settlement` ledger legs keyed `late_seat_settle:<hand>:<player>`;
- 15 debits totalling 105.85 and 7 credits totalling 138.34;
- every player a horse of Club JAQK or SHARK CLUB.

Each is a real, completed settlement. Its settlement row, idempotency key, provenance receipt, accepted outcome, signed request, wallet credit and funding lineage all exist and agree.

## Cause

`fn_union_pnl_prove_late_settlement` proves a hand in one of two ways:

- from its live `hand_atomic_commits` row;
- once that row is retained and pruned, from its `horse_settlement_key_certificates` row.

The retained branch compared the certificate's `accounting_evidence_sha256` with the sha256 of the outcome's full evidence. But `compact_horse_settlement_keys` writes that digest over `fn_pnl_cash_hand_evidence`, the base evidence. Every outcome row carries the base evidence plus `accepted_bbj`, `accepted_rake` and `accepted_external_net`.

Read over all 472,751 certificates in production, the digest equals the outcome evidence without those three keys on every one, and the full evidence on none. The retained branch could never prove a hand. Compaction retained these 22 hands at 2026-10-14 15:33, which is why the earlier certificate was clean and today's was not.

## Fix

Migration `20261015132419` makes the retained branch digest the outcome evidence in the shape the certificate was written over. Nothing else in the proof changes.

Proved in production with a pg_temp successor: all 22 flows prove, one row each, net 32.49 (138.34 - 105.85), where today none does. The function is not a pinned original-inventory source, so no certificate's generation moves. The weekly close re-proves the problem windows on its own schedule.

Pinned by `tests/a-retained-late-settlement-reads-its-certified-evidence.law.test.ts`.
