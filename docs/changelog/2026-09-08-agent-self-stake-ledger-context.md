# Agent self-stake restores its ledger context

fn_agent_wallet_self_stake declared transaction-local ledger settings, then left them changed after success and after an insufficient-funds return. It also reset the agent skip flag to an empty value instead of preserving the caller's prior value. A later operation in the same transaction could inherit the self-stake category, counterparty and correlation.

The function now captures and restores all eight ledger settings it touches, clears unrelated tournament/settlement context during its own movement, and restores context on both successful and insufficient-funds exits. Wallet debit, player credit, ledger and business receipt remain one transaction. No watcher or historical correction was added.

The original production body fails the isolated self-stake context test. The replacement passes 30 new cases: successful movement, replay, insufficient funds, 20 injected write failures and seven invalid amounts. The complete isolated PostgreSQL run passes 493 scenarios. Live body verified as 438f699e38c8e2e6a9949c76e526731b. Anonymous execution remains denied; authenticated/service execution remains as before.

Applied through Supabase apply_migration as 20260908151800. The uncommitted reservation 20260908151305 was aligned to the database-assigned version before committing; published migration history was not rewritten.

This hardens the canonical club self-stake function. Rewiring legacy agent portal wallet selection and fully durable interrupted-hand recovery remain separate open work.
