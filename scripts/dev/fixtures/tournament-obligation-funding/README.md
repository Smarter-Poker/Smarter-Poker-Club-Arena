# Cumulative tournament obligation funding rehearsal

Run from the repository root after the shared registration runner's obligation selector is integrated:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --obligations-only
```

The selector calls `tournament_obligation_funding_cases.verify(q, fresh, overlap, call, check)`. The entry/cancellation lane owns that shared runner change. There is no default invocation of this module.

This uses the existing isolated PostgreSQL 17 runner and its actual registration, wallet, ledger and escrow fixtures. Each group starts with synthetic users and a fresh database. The added fixture captures nine installed helper functions, three supporting tables, the current obligation/payout unique indexes and the actual payout evidence triggers. The module asserts the captured function body hashes before applying the candidate migration locally and checking its body hash.

Ten groups verify cumulative early/final deltas, overlapping identical and increasing claims, recipient ownership, rollback after a late evidence failure, short-bank debt preservation, immutable payout history, refused second-place debt creation, zero-payment reservations and existing positive legacy receipt replay. The legacy input is created locally through the real low-level credit writer.

The original installed body reproduces the second-place defect: a refused request leaves a second debt. Add `--obligation-baseline` to skip the candidate migration and reproduce that expected assertion failure. The first seven baseline groups passed. With the revised candidate all ten groups passed and the private cluster stopped normally.

The candidate changes only the pre-insert refusal for a new finishing obligation. It does not repair existing debts or payout history. No production money function is called by this rehearsal, and the runner accepts no production database URL.

This is a narrow cumulative-writer proof, not a full production clone or integrated tournament terminal proof. It does not certify HTTP/RLS access, the complete production trigger graph, authoritative rank ordering, or prize/bounty/fee terminal closeout.

Evidence: `docs/audits/2026-09-10-phase3-cumulative-obligations-evidence.json`.
