# tests/a-commission-payment-is-on-the-journal.law.test.ts

Phase 8 of 8 (union accounting), Control. Both commission payers -
fn_settle_round2_club_to_agents and fn_agent_claim_commission - must post the
payment to chip_ledger as a leg crossing club_treasury -> player_wallet under
category commission, keyed so a replayed close or a retried claim cannot
double-post. Before 20260908113416 neither wrote a leg at all: they moved
clubs.chip_treasury and club_members.chip_balance directly and recorded the
movement in two unrelated one-sided tables, which fn_ca_trial_balance reads as
drift by construction.
