-- 20261016104032_a_diamond_event_fee_owes_no_attribution
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16 10:40:32 UTC.
--
-- A DIAMOND EVENT'S FEE OWES NO ATTRIBUTION (2026-10-16)
--
-- What fired. RakeAttributionBacklog (infra/monitoring/spin-rules.yml,
-- poker_rake_attribution_gaps > 100 for 30m) fired and resolved seven times
-- between 02:03 and 06:28 UTC on 2026-10-16 as the count crept from 101 to
-- 106; at 10:38 it was 107. The gauge is fn_spin_metrics' count of
-- v_tournament_rake_attribution_gaps.
--
-- The cause, read from rows. Every one of the 107 rows is verdict
-- credited_nobody, destination 'diamond_house', club "Diamond Arena" (asset
-- diamonds): 89 from engine.fn_complete_tournament_terminal (64,618 Diamonds of
-- fees) and 18 from engine.fn_settle_satellite_tournament (646), settled
-- between 2026-10-07 13:03 and 2026-10-16 10:19, 3,914 entrants. None has an
-- accounting source or a fee receipt, because none is owed one:
-- fn_settle_tournament_rake's DIAMOND PHASE 8 branch sends a Diamond event's
-- fee to the house through fn_poker_diamond_tournament_settle_fee and writes
-- attributed_users = 0 deliberately. VIP points, rakeback basis and agent
-- commission are chip accounting; nothing is denominated in Diamonds. The
-- view counted a settlement that owes nobody as one that credited nobody, so
-- the alarm rose with every Diamond event and would never fall. A detector
-- firing on a non-defect is the defect (CLAUDE.md 10.11): its line is the
-- view's WHERE.
--
-- The money is right. No player is owed anything: the fees reached the
-- Diamond house exactly as Phase 8 specifies, and chip attribution is unchanged
-- for every chip event (every chip settlement with amount > 0 still appears
-- here when it credits nobody). Not caused by an r5 install: the rows began on
-- 2026-10-07 and crossed the threshold by accumulation.
--
-- The fix. The view excludes destination 'diamond_house'. Columns, order,
-- security_invoker and grants are unchanged (CREATE OR REPLACE VIEW keeps the
-- privileges; the options are restated). Its only reader is fn_spin_metrics.
-- Measured read-only on production 2026-10-16 10:38: 107 rows before, 0 after.
--
-- HOW: the live view text must hash to the md5 read on production on
-- 2026-10-16 (316450d4...); the replacement is the same text with one more
-- predicate, and the migration asserts the predicate, the option and the grants
-- after.
--
-- Regression: scripts/ci/test-a-diamond-event-fee-owes-no-attribution.py
-- (native PostgreSQL), run by
-- .github/workflows/a-diamond-event-fee-owes-no-attribution.yml.
--
-- @live-proof: (SELECT position('diamond_house' IN pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) > 0)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pin$
DECLARE v_def text := pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass);
BEGIN
  IF md5(v_def) <> '316450d4ce44fa135965716cce6ab8e4' THEN
    RAISE EXCEPTION 'v_tournament_rake_attribution_gaps is not the pinned text (md5 %)', md5(v_def);
  END IF;
  -- Remember the owner and grants as they stand, to prove they did not move.
  PERFORM set_config('ca.gaps_view_acl',
    (SELECT COALESCE(c.relacl::text, '') || '|' || pg_get_userbyid(c.relowner)
       FROM pg_class c WHERE c.oid = 'public.v_tournament_rake_attribution_gaps'::regclass), false);
END $pin$;

CREATE OR REPLACE VIEW public.v_tournament_rake_attribution_gaps WITH (security_invoker = true) AS
 SELECT r.tournament_id,
    r.club_id,
    r.amount,
    r.source,
    r.settled_at,
    r.attributed_at,
    r.attributed_users,
    r.attribution_error,
    t.tournament_type,
    t.variant,
    t.name,
    t.buy_in_amount,
        CASE
            WHEN (r.attributed_users IS NULL) THEN 'never_measured'::text
            WHEN (r.attributed_users = '-1'::integer) THEN 'attribution_threw'::text
            WHEN (r.attributed_users = 0) THEN 'credited_nobody'::text
            ELSE 'ok'::text
        END AS verdict
   FROM (tournament_rake_settlements r
     LEFT JOIN tournaments t ON ((t.id = r.tournament_id)))
  WHERE ((r.settled_at IS NOT NULL) AND (r.amount > (0)::numeric) AND ((r.attributed_users IS NULL) OR (r.attributed_users <= 0)))
    -- A DIAMOND EVENT'S FEE OWES NO ATTRIBUTION (2026-10-16). Diamond Phase 8:
    -- fn_settle_tournament_rake sends a Diamond event's fee to the house
    -- (destination 'diamond_house') and records attributed_users = 0 on
    -- purpose; no VIP points, rakeback basis or commission is denominated in
    -- Diamonds. It is not a gap.
    AND (r.destination IS DISTINCT FROM 'diamond_house');

DO $post$
BEGIN
  IF position('diamond_house' IN pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) = 0 THEN
    RAISE EXCEPTION 'v_tournament_rake_attribution_gaps does not carry the diamond_house predicate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.v_tournament_rake_attribution_gaps'::regclass
                    AND COALESCE(c.relacl::text, '') || '|' || pg_get_userbyid(c.relowner)
                          = current_setting('ca.gaps_view_acl')
                    AND c.reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'v_tournament_rake_attribution_gaps: owner, grants or security_invoker moved';
  END IF;
END $post$;

COMMIT;
