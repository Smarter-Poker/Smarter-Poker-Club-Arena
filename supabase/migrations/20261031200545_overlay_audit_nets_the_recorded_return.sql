-- 20261031200545_overlay_audit_nets_the_recorded_return.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_overlays reported GROSS guarantee funding and said in its own
-- text that "reviewed returns are not netted". But the platform's live path
-- already returns an overlay the field outgrew: when late registration,
-- rebuys and add-ons carry the pool past the guarantee it writes a
-- chip_ledger `reversal` from prize_liability back to the bank that funded it
-- ("Guarantee overlay excess returned to its source", 537 rows over the last
-- 30 days). So on 2026-10-30 the Nightly 10K (NLH) e48479cd was raised as a
-- CRITICAL 4,172.50 overlay "decision for Dan": funded at 00:04 when the
-- field had made 5,827.50, returned in full at 01:32 when the pool reached
-- 19,362.00. Its net cost to the house was zero.
--
-- The entry-only estimate had the same blind spot: entries x buy-in ignores
-- rebuys and add-ons, so the diamonds Nightly 10K 4749c582 (prize pool
-- 102,480 against a 100,000 guarantee) was reported with a 45,820 "gap".
--
-- Now: net funding = recorded funding minus its recorded return, and the
-- estimate uses the larger of entries x buy-in and the event's prize_pool.
-- An overlay funded and fully returned is reported as info
-- (tournament_overlay_returned), never as a cost. The body replaced is the
-- live one installed by 20261026143605 (md5 of prosrc
-- 791e3e3a1c4297d7a8655634afe41325); the guard refuses any other.
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_audit_overlays(date)'::regprocedure)
     IS DISTINCT FROM '791e3e3a1c4297d7a8655634afe41325' THEN
    RAISE EXCEPTION 'fn_audit_overlays is not the 20261026143605 body this migration was written against';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_audit_overlays(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $overlay$
DECLARE v jsonb := '[]'::jsonb; r record; total numeric := 0; gross numeric := 0; n integer := 0;
BEGIN
  FOR r IN
    WITH eligible AS MATERIALIZED (
      SELECT t.id,t.name,t.guaranteed_prize gtd,t.buy_in_amount bi,
             coalesce(t.prize_pool,0) pool,
             (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id) entries
      FROM public.tournaments t
      WHERE t.guaranteed_prize>0 AND t.buy_in_amount>0
        AND t.started_at >= p_day::timestamp AT TIME ZONE 'UTC'
        AND t.started_at < (p_day+1)::timestamp AT TIME ZONE 'UTC'
    ), funded AS (
      SELECT e.*,
        coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.tournament_id=e.id AND l.category='overlay'
            AND l.to_type='prize_liability'),0) journal,
        coalesce((SELECT o.amount FROM public.tournament_guarantee_overlays o
          WHERE o.tournament_id=e.id),0) legacy,
        -- The live path's own return of an overlay the field outgrew.
        coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.tournament_id=e.id AND l.category='reversal'
            AND l.from_type='prize_liability'
            AND l.description LIKE 'Guarantee overlay excess returned%'),0) returned
      FROM eligible e
    ), measured AS (
      -- Same funding precedence as tournament conservation: two records of
      -- one funding are never added together. Net is what the house kept in.
      SELECT f.*,greatest(journal,legacy,0) funding,
             greatest(greatest(journal,legacy,0)-returned,0) net_funding,
             greatest(gtd-greatest(entries*bi,pool),0) entry_only_gap FROM funded f
    ), counted AS (
      SELECT m.*,sum(net_funding) OVER () all_net,sum(funding) OVER () all_gross,
             count(*) FILTER (WHERE net_funding>0) OVER () funded_events,
             count(*) FILTER (WHERE funding=0 AND entry_only_gap>0) OVER () unconfirmed_events
      FROM measured m WHERE funding>0 OR entry_only_gap>0
    )
    SELECT * FROM counted ORDER BY net_funding DESC,funding DESC,entry_only_gap DESC,id LIMIT 10
  LOOP
    total:=r.all_net; gross:=r.all_gross; n:=r.funded_events;
    v:=v||jsonb_build_object(
      'severity',CASE WHEN r.net_funding>=200 THEN 'critical'
                      WHEN r.net_funding>0 OR (r.funding=0 AND r.entry_only_gap>0) THEN 'warn'
                      ELSE 'info' END,
      'category','logic',
      'code',CASE WHEN r.net_funding>0 THEN 'tournament_overlay'
                  WHEN r.funding>0 THEN 'tournament_overlay_returned'
                  ELSE 'tournament_overlay_estimate' END,
      'title',CASE WHEN r.net_funding>0 THEN r.name||' cost '||round(r.net_funding,2)||' in guarantee overlay'
                   WHEN r.funding>0 THEN r.name||' funded '||round(r.funding,2)||' of guarantee overlay and returned it all'
                   ELSE r.name||' has an entry-only gap with unconfirmed funding' END,
      'evidence',jsonb_build_object('tournament_id',r.id,'guarantee',r.gtd,'buy_in',r.bi,
        'entries',r.entries,'prize_pool',r.pool,'entry_only_gap',r.entry_only_gap,
        'funded_overlay',r.funding,'returned_overlay',r.returned,'net_overlay',r.net_funding,
        'journal_overlay',r.journal,'legacy_overlay',r.legacy,
        'funding_confirmed',r.funding>0,'basis','net_recorded_funding',
        'funded_events',r.funded_events,'unconfirmed_events',r.unconfirmed_events),
      'recommendation',CASE WHEN r.net_funding>0 THEN
        'Net guarantee funding is the house cost after the live path''s own return of any excess. It is an honoured guarantee, not proof of an overlay-guard defect; trace the pre-start eligibility and registration decisions before diagnosing the guard.'
        WHEN r.funding>0 THEN
        'The field outgrew the guarantee after start and the live path returned the whole overlay to the bank that funded it. Nothing was spent and nothing needs deciding.'
        ELSE 'This is an estimate from the larger of entries x buy-in and the prize pool, not money proved paid. Inspect original funding and entry receipts before claiming an overlay or diagnosing the guard.' END);
  END LOOP;
  IF jsonb_array_length(v)>0 THEN
    v:=v||jsonb_build_object('severity','info','category','logic','code','overlay_total',
      'title','Net guarantee overlay: '||round(total,2)||' across '||n||' event(s) ('||round(gross,2)||' funded before returns)',
      'evidence',jsonb_build_object('events',n,'total_overlay',round(total,2),'gross_funding',round(gross,2),
        'basis','net_recorded_funding','detail_limit',10),
      'recommendation','Total includes every event started in the UTC day, including events beyond the ten displayed details. Net is recorded funding minus the live path''s recorded return of excess; entry-only estimates are excluded.');
  END IF;
  RETURN v;
END
$overlay$;
REVOKE ALL ON FUNCTION public.fn_audit_overlays(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_overlays(date) TO service_role;

COMMIT;
