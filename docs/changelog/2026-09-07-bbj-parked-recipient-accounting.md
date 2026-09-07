# BBJ parked-recipient accounting

The original recipient helper returned a parked share to the bank before its conflict-safe parking insert. The first Main retry refunded it twice. Mini shares were returned to Main instead of Backup. Later redemption credited the recipient without reclaiming the returned funding.

The original helper now locks the payout pool, lets the unique parked row own one refund, uses the payout kind to select the original bank, rejects changed parked entitlements, and atomically reclaims funding when paying a parked recipient. It records paid_at for wallet and seat destinations. Insufficient funding rolls the entire redemption back. Duplicate active seats also roll back rather than crediting multiple stacks. Its existing service-only ACL is explicit.

Validation: the deployed original failed on the first Main repeated park. The replacement actual function body passed Main/Mini parking, four retries each, changed entitlement rejection, unfunded redemption rollback, funded wallet/seat redemption, paid receipts, duplicate redemption, direct wallet/seat retries and duplicate-seat rollback. Each probe was a single self-aborting DO block with pg_temp fixtures. Ledger declaration, home-club and wallet-ensure helpers were stubbed; production triggers, concurrent sessions, browser flows and engine restart recovery were not exercised. The executable deployed-function probe is tests/sql/bbj_parked_recipient_rollback_probe.sql.

No historical player balance changes: the read-only review found zero unclaimed-share rows. This closes the helper's repeated-refund, wrong-bank and unfunded-credit defects, not the whole jackpot audit. Outstanding parked obligations still need protection from other bank writers; Mini replay/engine retry recovery and truthful payout notifications remain open.

Applied to the database as migration 20260907202012. The same rollback probe passed again against the installed function definition.
