# tests/law/a-players-giftable-balance-is-not-public.law.test.ts

fn_ca_giftable_balance answers for any user id, so no browser role (anon, authenticated) may execute it: one player can never read another player's diamond balance; service_role and the definer send_stream_gift keep it (migration 20261002133829).
