-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906093746; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906093746   (the stamp IS the apply time, UTC: 2026-09-06 09:37:46)
--   name        tag_ev_title_typo
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2624 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906093746 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_audit_river_aggression_ev
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- A stray non-ASCII character reached a finding title. Findings are read by
-- people; fix it at the source rather than in the reader.
create or replace function public.fn_audit_river_aggression_ev(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_ranked int := 0;
begin
  for r in
    select * from fn_horse_tag_ev(p_day - 6)
     where mirrored and hands >= 200
     order by bb_per_hand asc
  loop
    v_ranked := v_ranked + 1;
    if r.bb_per_hand < 0 then
      v := v || jsonb_build_object('severity', case when r.net_bb < -20000 then 'warn' else 'info' end,
        'category','gto','code','tag_ev_negative',
        'title', r.situation || ' is losing ' || r.bb_per_hand || 'bb per hand over ' || r.hands || ' hands',
        'evidence', jsonb_build_object('situation', r.situation, 'hands', r.hands,
                                       'won_hands', r.won_hands, 'net_bb', r.net_bb,
                                       'bb_per_hand', r.bb_per_hand, 'win_rate', r.win_rate),
        'recommendation','Both outcomes of this situation are counted, so this is EV and not a damage total. A negative number here is a real leak and a cap is worth testing: flag it, add a league matchup, and do not claim an improvement without significance.');
    end if;
  end loop;

  if v_ranked = 0 then
    v := v || jsonb_build_object('severity','info','category','schema','code','tag_ev_unavailable',
      'title','No mirrored situation has 200 hands in the seven-day window',
      'evidence', jsonb_build_object('day', p_day),
      'recommendation','horse_review_rollup.leak_net_bb is written by fn_hhr_rollup_add on every review insert. If counts exist and nets do not, the rollup is running a build from before 2026-09-06.');
  else
    v := v || jsonb_build_object('severity','info','category','gto','code','tag_ev_ranked',
      'title', v_ranked || ' mirrored situations ranked by EV over seven days',
      'evidence', jsonb_build_object('situations', v_ranked, 'since', p_day - 6),
      'recommendation','Ranked by bb per hand across BOTH outcomes, which is the only honest ranking: a loss-only total ranks situations by how often they occur in big pots. The fold family has no winning mirror and is deliberately excluded - a folded hand never wins, so its total is the fold, not a leak.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_river_aggression_ev(date) from public, authenticated, anon;
grant execute on function public.fn_audit_river_aggression_ev(date) to service_role;
