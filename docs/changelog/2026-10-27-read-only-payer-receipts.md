# Read-only payer receipts

Exact native post-COMMIT BEGIN READ ONLY receipt verification exposed a compatibility regression: the new request-local payer cache attempted CREATE TEMP TABLE, forbidden in a read-only transaction. The existing private helper now returns the unchanged original pure validator output when PostgreSQL reports transaction_read_only. Its financial READWRITE cache code, metadata, private ACL and original split receipt owner remain unchanged.
Native18 cases retain real R2/R3 and deferred financial fault checks, plus real committed READONLY success/no TEMP and bad-invoice refusal. The old142050 installed file and73150 file remain immutable; existing alias supersession maps142050 to this follow-up, whose live proof retains unchanged reserve/validator/split and exact new helper. No financial/source proof renewal or historical data edits.
Root owns production installation and money; native qualification does not prove deployment or completed payments.
