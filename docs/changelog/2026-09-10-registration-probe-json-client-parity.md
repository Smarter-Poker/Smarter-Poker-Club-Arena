# Registration probe client parity

## 2026-09-10: Registration Rehearsal Preserves JSON Strings Across Clients

The current-dependency rehearsal parsed PostgreSQL JSON scalar text with json.loads. psql retained the JSON quotes, while the CI Node client decoded the scalar first, failing before the accounting assertions. Both scalar projections now cast their JSON encoding to PostgreSQL text so each client returns identical encoded text. All source fingerprints and financial assertions remain in force. Verified: all 23 native PostgreSQL behavior groups passed independently through psql and PGNODE, including rollback, concurrent replay and exact charged-wallet receipts. Re-read: yes; no application money function or production database changed.

Evidence: `/tmp/ca-registration-funding-pg17-gig2hmxr/results.json` (psql) and `/tmp/ca-registration-funding-pg17-bo2kr01p/results.json` (Node), both 23/23 with exit 0. Initial PR4096 CI run34435212230 failed at this parse before the remaining accounting suite. Required CI rerun and publication remain pending.
