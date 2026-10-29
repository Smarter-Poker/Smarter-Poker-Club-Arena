#!/usr/bin/env python3
"""Render the narrow clock-floor replacement from its captured original owner."""
import json, hashlib, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
DATA=Path('scripts/ci/fixtures/played-clock-floor')
MIGRATION=Path('supabase/migrations/20261029004521_keep_generation_recovery_at_the_highest_genuinely_played_lev.sql')
capture=json.loads((ROOT/DATA/'abort-preimage.json').read_text())
LIVE_PROOF="EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)') AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] AND position('ORDER BY s.level_index DESC,s.played_at DESC LIMIT 1;' IN p.prosrc)>0 AND position('min(l.level_index)' IN p.prosrc)>0 AND position('WHERE s.level_index>v_found' IN p.prosrc)>0)"
old="""    IF v_found IS NOT NULL AND v_found < event.current_level THEN
      v_r := public.fn_resolve_tournament_blinds(event.blind_structure, v_found,"""
new="""    -- A RECOVERED OLDER HAND DOES NOT REWIND A PLAYED LATER LEVEL.
    -- A recovered original ends now with its original blinds. Latest-ended
    -- evidence alone would let that older level erase a higher level the
    -- field genuinely played before the outage. Read the event's completed
    -- blind pairs once, map them through its existing resolver, and retain
    -- the highest supported level at or below the current clock. This is
    -- only a floor on an existing backwards correction, never an advance.
    IF v_found IS NOT NULL AND v_found < event.current_level THEN
      WITH played AS MATERIALIZED (
        SELECT hh.small_blind, hh.big_blind,
               max(COALESCE(hh.ended_at,hh.created_at)) AS played_at
          FROM public.hand_history hh WHERE hh.tournament_id=t
         GROUP BY hh.small_blind,hh.big_blind
      ), levels AS MATERIALIZED (
        SELECT i AS level_index,
               public.fn_resolve_tournament_blinds(event.blind_structure,i,
                 event.variant,event.tournament_type,NULL) AS state
          FROM generate_series(0,LEAST(event.current_level,600)) AS i
      ), supported AS (
        -- Repeated/capped pairs cannot prove a later identical level was
        -- played. Keep the first matching index, as the existing owner does.
        SELECT p.small_blind,p.big_blind,p.played_at,
               min(l.level_index) AS level_index
          FROM levels l JOIN played p
            ON p.small_blind=(l.state->>'small_blind')::numeric
           AND p.big_blind=(l.state->>'big_blind')::numeric
         GROUP BY p.small_blind,p.big_blind,p.played_at
      )
      SELECT s.small_blind,s.big_blind,s.played_at AS created_at,s.level_index
        INTO v_hh FROM supported s WHERE s.level_index>v_found
       ORDER BY s.level_index DESC,s.played_at DESC LIMIT 1;
      IF FOUND THEN
        v_found:=v_hh.level_index;
        v_ev_at:=v_hh.created_at;
        v_ev_sb:=v_hh.small_blind;
        v_ev_bb:=v_hh.big_blind;
      END IF;
    END IF;
    IF v_found IS NOT NULL AND v_found < event.current_level THEN
      v_r := public.fn_resolve_tournament_blinds(event.blind_structure, v_found,"""
def render():
    if capture['definition'].count(old)!=1:
        raise RuntimeError('clock replacement boundary drift')
    updated=capture['definition'].replace(old,new)
    pre=hashlib.md5(capture['definition'].encode()).hexdigest()
    post=hashlib.md5(updated.encode()).hexdigest()
    if pre!=capture['definition_md5']:
        raise RuntimeError('captured generation-abort definition drift')
    checks="pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']"
    signature='public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'
    return f"""-- A recovered older hand retains its original blinds; it cannot erase a
-- higher level the tournament genuinely played before the outage. Only the
-- original generation-abort clock selection changes. Existing financial,
-- lease, snapshot, permit, authority and receipt checks remain byte-identical.
-- Native proof invokes the captured real F06 abort door before/after, retains
-- its legitimate backwards correction, and proves complete financial rollback.
-- @live-proof: {LIVE_PROOF}
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $played_clock$
DECLARE prior text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('{signature}')
      AND md5(pg_get_functiondef(p.oid))='{pre}' AND {checks}) THEN
    RAISE EXCEPTION 'PLAYED_CLOCK_OWNER_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT pg_get_functiondef('{signature}'::regprocedure) INTO prior;
  EXECUTE replace(prior,$old_clock${old}$old_clock$,$new_clock${new}$new_clock$);
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('{signature}')
      AND md5(pg_get_functiondef(p.oid))='{post}' AND {checks}) THEN
    RAISE EXCEPTION 'PLAYED_CLOCK_OWNER_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
END $played_clock$;
COMMIT;
"""

if __name__=='__main__':
    sql=render()
    if '--check' in sys.argv:
        if sql!=(ROOT/MIGRATION).read_text():
            raise SystemExit('played-level recovery migration differs from its captured owner')
        print('played-level recovery migration matches its captured owner')
    else:
        (ROOT/MIGRATION).write_text(sql)
