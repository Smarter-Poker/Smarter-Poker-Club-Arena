# Bounded capacity inputs for leaderboard wizard certification

Production certificate37884035112 failed before fixture creation because its complete Mint overview RPC returned500 at a statement timeout. That overview computes lifetime reconciliation and seat totals, while the certificate consumes only rolling24-hour chip issuance and its ceiling.

The certificate now reads the existing stable read-only rolling issuance RPC and the single existing policy row, validates both responses and derives headroom. Unknown, malformed or insufficient capacity still refuses; the actual issuance transaction remains authoritative. No Mint policy, grant, migration, financial record or timeout setting is changed.

Focused regression covers the exact two requests, numeric parsing, missing/ambiguous policy, failed reads and insufficient-capacity refusal. Read-only native plans showed the rolling query using the existing created-time index; they do not identify the exact statement inside the earlier timeout or prove the new hosted certificate passed.
