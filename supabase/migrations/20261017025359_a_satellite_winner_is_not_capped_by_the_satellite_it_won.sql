-- 20261017025359_a_satellite_winner_is_not_capped_by_the_satellite_it_won
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 02:53:59 UTC.
--
-- A SATELLITE WINNER IS NOT CAPPED BY THE SATELLITE IT WON (2026-10-17)
--
-- "Sunday Deep Stack Satellite 10" (a4445447, a Diamond satellite, 24
-- entrants) decided its winner at 01:32:07 UTC and could not finish: every
-- settlement attempt was refused with diamond_satellite_winner_at_the_table_cap
-- for its winner 82c24bec. Read at 02:50: the winner held four live seats -
-- one of them the satellite's own final table 979b9ac2 - and two bookings
-- inside the hour.
--
-- THE CAUSE. Both satellite settlement authorities
-- (fn_settle_satellite_tournament_pre_money_path_gate and
-- fn_ca_settle_satellite_cohort) ask fn_concurrent_game_load(winner, NULL,
-- NULL, target). That function stops counting a tournament's seats once the
-- tournament is COMPLETING, COMPLETED or CANCELLED (2026-09-10, written for
-- exactly this case), but a satellite is still RUNNING while it settles, so
-- the winner's own satellite seat - which this same settlement releases - is
-- counted as another game. For a Diamond satellite that is a refusal; for a
-- chip satellite it turned the seat into a noncash ticket.
--
-- It is also a livelock. The booking cap admits a new game while the load,
-- satellite seat included, is under four: with the satellite seat and two
-- other games a winner may book a third, and the settlement then sees four.
-- Every retry can lose that way for as long as the winner keeps playing.
--
-- THE FIX. Each authority passes the winner's live seat at this satellite as
-- p_exclude_table_id. The cap is unchanged and still absolute: a winner with
-- four OTHER games is still refused (Diamond) or held a noncash ticket
-- (chip), as Diamond phase 9 decided. Nothing else in either function
-- changes. No money moves here; the engine's own retry settles the satellite
-- once the winner has three or fewer other games, and because the satellite
-- seat still counts toward any new booking, the winner can no longer book
-- its way back over.
--
-- GUARDS: refuses in the break window; each live body must be the exact
-- preimage or already the postimage; the replaced passage must occur exactly
-- once; the computed postimage must be the pinned one; owner, SECURITY
-- DEFINER, configuration and ACL are unchanged; each readback must be the
-- exact postimage. Verified on a native Postgres against the live preimages
-- (both read back byte-identical, before and after) before this was written.
-- @live-proof: md5(pg_get_functiondef('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure)) = 'd98767846aeab9497aaeae71a082d972'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_settle_satellite_cohort(uuid,uuid[])'::regprocedure)) = '0883aa98fdf1e688cc26c4792685a9dd'

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'SATELLITE_CAP_SELF_SEAT_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $install$
DECLARE
  c_old constant text := $old$        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);$old$;
  c_new constant text := $new$        -- THE SATELLITE BEING SETTLED IS NOT ANOTHER GAME (2026-10-17). The
        -- winner still holds a seat here until this settlement releases it,
        -- and the satellite is RUNNING, so that seat counted against the
        -- target entry it just won and a winner with three other games was
        -- refused by its own final table.
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,
          (SELECT ts.table_id
             FROM public.table_seats ts
             JOIN public.tables tb ON tb.id = ts.table_id
            WHERE tb.tournament_id = p_tournament_id
              AND ts.user_id = v_finisher.user_id
              AND ts.left_at IS NULL
            ORDER BY ts.table_id
            LIMIT 1),
          v_target_id);$new$;
  r record;
  v_oid oid;
  v_def text;
  v_new text;
  v_owner oid; v_secdef boolean; v_config text[]; v_acl text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'satellite cap: must run as postgres';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
     '384887d62082eec9a0d61a9d49d955a2', 'd98767846aeab9497aaeae71a082d972'),
    ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',
     'e8986b5b177c88acbde1ac80fe7e029f', '0883aa98fdf1e688cc26c4792685a9dd')
  ) AS v(sig, pre_md5, post_md5)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'satellite cap: % is missing', r.sig;
    END IF;
    v_def := pg_get_functiondef(v_oid);
    CONTINUE WHEN md5(v_def) = r.post_md5;
    IF md5(v_def) <> r.pre_md5 THEN
      RAISE EXCEPTION 'satellite cap: unexpected live body for % (%)', r.sig, md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
      RAISE EXCEPTION 'satellite cap: the cap passage is not exactly once in %', r.sig;
    END IF;
    v_new := replace(v_def, c_old, c_new);
    IF md5(v_new) <> r.post_md5 THEN
      RAISE EXCEPTION 'satellite cap: computed postimage for % is %', r.sig, md5(v_new);
    END IF;
    SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl::text
      INTO v_owner, v_secdef, v_config, v_acl
      FROM pg_proc p WHERE p.oid = v_oid;
    EXECUTE v_new;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_new THEN
      RAISE EXCEPTION 'satellite cap: exact readback failed for %', r.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
                     AND p.proowner = v_owner AND p.prosecdef = v_secdef
                     AND p.proconfig IS NOT DISTINCT FROM v_config
                     AND p.proacl::text IS NOT DISTINCT FROM v_acl) THEN
      RAISE EXCEPTION 'satellite cap: authority drift on %', r.sig;
    END IF;
  END LOOP;
END
$install$;

COMMIT;
