# Original horse tournament funding evidence

The public horse registration caller and seat-first horse admission reach a separate original chip debit owner. That owner bypassed the human admission producer, so positive live horse entries had original debits and registrations but no participant funding receipt.

Successor `20260918002654` changes only `fn_register_horse_for_tournament_before_maintenance_gate(uuid,uuid)`. It retains this transaction's returned entitlement and wallet IDs, then binds them to the actual registration through the existing immutable receipt helper. Ticket selection, Diamond refusal, admission checks, seat/capacity guards and all original monetary amounts stay with their existing owners. There is no historical backfill; ticket instruments are not certified as wallet-funded entries.

The existing native tournament runner exposes `--accounting-horse-only` and includes its cases in `--with-heads-up-payout`. It reproduces the original public caller's missing receipt, then verifies exact charged-club/ledger/entitlement/wallet/registration identity, duplicate calls, full rollback on a missing debit reference and zero-price entries without fabricated money. The unchanged seat-first wrapper delegates to the same patched core; this focused qualification does not requalify gameplay or ticket-funded economics.

The exact migration was also installed in a separate private native database with its original source guards. Readback matched the generated definition, original `postgres` owner and private ACL. Production installation and subsequent original receipt observation are separate delivery checks.
