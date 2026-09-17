CREATE TABLE public.fixture_concurrent_replay AS
WITH seeded AS MATERIALIZED (SELECT fixture_replay_case() id)
SELECT id,(SELECT tournament_id FROM tournament_bounty_obligations WHERE id=seeded.id) tournament_id,
NULL::jsonb financial_snapshot FROM seeded;
-- Use a following command snapshot so it sees all function-owned writes.
UPDATE fixture_concurrent_replay f SET tournament_id=o.tournament_id FROM tournament_bounty_obligations o WHERE o.id=f.id;
UPDATE fixture_concurrent_replay SET financial_snapshot=fixture_financial_snapshot(tournament_id);
