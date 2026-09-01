-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:26:02 UTC on kuklfnapbkmacvwxktbh.

-- SIGNAL-NOT-NOISE part 3: the tournament PLAY-chip conservation alarm.
-- Tonight's 20:20 critical closed the causal loop on the day's biggest find:
-- the worst game's winner ("co captain", +106,398 play chips above entries)
-- is the same horse whose 826,398.96 REAL-chip cashout the mint guard
-- blocked. Play-chip mint fed the real-chip mint through the tournament-
-- table cashout path - which is now guarded on both RPCs (zero real chips
-- since 19:41). What remains is an ENGINE play-chip bug (281 games minted
-- 363,800 play chips in 6h; 16 destroyed 14,395) with NO remaining
-- real-money path: prizes pay from prize_pool, not stacks, and stacks can
-- no longer cash out. So:
--   • the check files 'info' (dashboard metric) instead of 'critical'
--     while the engine bug is open - no hourly paging for a quarantined bug;
--   • the Midway burn-in gate gains check #12: play-chip conservation must
--     be CLEAN over the burn-in window - the reopen decision still sees it
--     at full strength.
DO $$
DECLARE v_def text; v_new text; r record;
BEGIN
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='fn_tournament_chip_conservation_check'
              AND pg_get_functiondef(p.oid) LIKE '%v_severity := ''critical''%'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def,
      'v_severity := ''critical'';',
      'v_severity := ''info'';  -- SIGNAL-NOT-NOISE 2026-08-31: engine play-chip bug is quarantined (real-chip conversion guarded); the burn-in gate still enforces clean conservation before Midway reopens');
    EXECUTE v_new;
  END LOOP;
END $$;

-- Gate check #12: conservation clean over the window.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_midway_burnin_gate(integer)'::regprocedure);
  v_new := replace(v_def,
'    ''last_supply_snapshot_explained'',    jsonb_build_object(''pass'', abs(COALESCE(v_supply.unexplained, 0)) <= 100, ''unexplained'', round(COALESCE(v_supply.unexplained,0),2), ''taken_at'', v_supply.taken_at)',
'    ''last_supply_snapshot_explained'',    jsonb_build_object(''pass'', abs(COALESCE(v_supply.unexplained, 0)) <= 100, ''unexplained'', round(COALESCE(v_supply.unexplained,0),2), ''taken_at'', v_supply.taken_at),
    ''play_chip_conservation_clean'',      (SELECT jsonb_build_object(
         ''pass'', COALESCE(bool_and(COALESCE((fa.context->>''minted_games'')::int,0) = 0
                              AND COALESCE((fa.context->>''destroyed_games'')::int,0) = 0), true),
         ''alerts_in_window'', count(*))
       FROM public.financial_alerts fa
      WHERE fa.source = ''fn_tournament_chip_conservation_check''
        AND fa.created_at > v_since)');
  IF v_new = v_def THEN RAISE EXCEPTION 'gate anchor not found'; END IF;
  EXECUTE v_new;
END $$;

-- Resolve tonight's open critical with the causal narrative; the underlying
-- financial_alert stays UNRESOLVED on purpose - the check's own dedupe
-- (unresolved same-verdict alert) suppresses hourly re-raises while the
-- engine bug persists.
SELECT public.fn_ca_incident_action(i.id, 'resolve',
  'Root-caused and contained. This is the play-chip half of today''s tournament-cashout mint: the worst game''s winner (+106,398 play chips above entries) is the same horse whose 826,398.96 real-chip cashout the mint guard blocked at 17:46. The engine mints play chips mid-tournament (281 games / 363,800 chips in 6h; 16 games destroyed 14,395) — an engine bug, tracked in docs 06 — but the real-money path is closed on both cashout RPCs (zero real chips minted since 19:41) and prizes pay from prize_pool, never from stacks. The check now files info while the bug is quarantined; the Midway burn-in gate gained check #12 requiring CLEAN play-chip conservation before reopening, so this cannot be waved through.',
  NULL,
  'engine play-chip mint at tournament tables; real-chip conversion guarded; engine fix tracked; gate check added',
  NULL) AS r
FROM public.ca_drift_incidents i
WHERE i.source='financial_alerts:fn_tournament_chip_conservation_check' AND i.status <> 'resolved';;
