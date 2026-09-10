# Funded Heads-Up prize composition

Run from the Club Arena repository root:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --heads-up-ladder-only
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --heads-up-payout-only
```

The runner creates and removes its own private PostgreSQL 17 cluster. It accepts no database URL. The first selector runs 20 groups: the existing 16 Heads-Up groups plus four funded ladder compositions. The second runs 32 groups: those 20 plus 12 actual payout, rollback and replay groups. The historical shared default suite has 53 total groups, including 16 Heads-Up groups; these selectors do not redefine that historical denominator. The existing isolated accounting CI passes --with-heads-up-payout, replacing its 16-group HU segment with the 32-group composition: 69 unique groups total (37 other and 32 HU), with no duplicated HU job. The no-flag default remains 53.

Each matrix case uses the actual public seat/buy-in function and lease-bound launch completion for two 200-chip entries. NLH and PLO4 each run with 300 and 1000 score chips per player. The installed ladder reader derives one 380-chip prize from the real 380 prize escrow, with 20 fee escrow retained. Score chips remain separate from custody.

The payout extension takes a synthetic winner as input and calls the actual cumulative obligation writer with the reader-derived amount. It injects a late payout-row failure and requires byte-exact rollback of every public fixture table. Two overlapping actual payments must move 380 and 0, leaving one matching obligation, payout, idempotency key and wallet receipt. The test also verifies the 380 ledger payment, exact replay, rejection of a different recipient and append-only payout history. Four wallet balances sum to 1980, the remaining fee escrow is 20, and opening custody of 2000 is conserved.

## Source provenance

`installed.sql` is byte-identical to the captured obligation fixture at commit `24217c5024a4c031aec51dbddba531cd3c1b7842`, path `scripts/dev/fixtures/tournament-obligation-funding/installed.sql`. It contains nine genuine function definitions, supporting schema and actual receipt triggers. The manifest pins its SHA-256 and function body hashes. The importer retains already-present HU support tables and installs missing captured constraints, indexes and triggers.

After asserting all nine archived body hashes, the composition imports the already-applied obligation successor from `20260910171857_a_refused_finishing_place_creates_no_debt.sql`. It then imports the selected approved September 10 settlement-lane, append-only guard and escrow successors, plus the installed amount reader. These source files and exact body hashes are pinned in `tournament_heads_up_ladder_cases.py`. The actual exercised payout catalog, including fixture owner, ACL, security-definer and configuration metadata, is archived with the native result.

This code imports function definitions into a private fixture. It does not apply the production migrations or reinterpret their source and authority guards.

## Limits

This is funded prize-payment evidence, not a full terminal proof. Winner identity is synthetic; no real dealer, accepted-hand witness or authoritative elimination is claimed. The final state intentionally remains RUNNING, with two occupied seats, zero terminal receipts and 20 fee custody. Current terminal readiness, rake attribution, seat exit, HTTP/RLS access, full production trigger/ACL parity and Stage B remain separate acceptance work.

No financial owner is replaced with a test double, no payout/obligation/credit receipt is manually seeded, and no production money function is called. Supporting auth and operational fixtures remain synthetic as documented by the existing HU fixture.

Final evidence: `docs/audits/2026-09-10-heads-up-funded-payout-native.json`.
