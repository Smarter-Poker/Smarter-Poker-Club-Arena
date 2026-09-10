/* THE HOST CLUB IS IN ITS OWN UNION (2026-09-10)

   fn_tournament_club_for_user resolves which club a player's tournament
   activity belongs to. Handed a preferred club, it accepts it only if the
   player holds an active/approved membership there AND that club is a row in
   union_clubs for the tournament's union.

   A tournament hosted BY a union has club_id = union_id. That house club is
   never a row in union_clubs - it is the union. So for any union-hosted
   tournament the preferred club could never pass, the resolver fell through to
   the horse-hash / oldest-membership pick, and returned some OTHER club the
   player belongs to.

   fn_settle_satellite_tournament_pre_money_path_gate then compares the resolved
   club with the target's club and refuses on a mismatch:

     satellite 9fee70de ticket place 1 has no exact target club   (P0404)

   Friday Night Feature Satellite Heads-Up: 38.00 pool, one player left, RUNNING
   for SIXTEEN HOURS on that refusal. Measured: target club fade0000...0001,
   target union fade0000...0001, the winner's membership there 'approved', and
   union_clubs holding zero rows for that club in its own union. The resolver
   returned a0000000...0001. The winner is a horse; per 10.5 that changes
   nothing about what they are owed.

   THE FIX: the tournament's own club counts as in the union without needing
   the row. Proved rolled back: the resolver now returns fade0000...0001 for
   this winner. The engine re-drives the satellite finish on its own; nothing
   here pays anything. */
DO $mig$
DECLARE v_src text; v_new text; v_a text; v_b text; v_n int; v_check uuid;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_club_for_user';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_tournament_club_for_user not found'; END IF;

  IF position('THE HOST CLUB IS IN ITS OWN UNION' in v_src) > 0 THEN
    RAISE NOTICE 'already applied'; RETURN;
  END IF;

  v_a := '  IF p_preferred_club IS NOT NULL' || E'\n' ||
         '     AND EXISTS (SELECT 1 FROM club_members m' || E'\n' ||
         '                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union' || E'\n' ||
         '                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club' || E'\n' ||
         '                   AND m.status IN (''active'',''approved''))' || E'\n' ||
         '  THEN';
  v_n := (length(v_src)-length(replace(v_src,v_a,'')))/length(v_a);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the preferred-club test appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
  END IF;

  v_b := '  /* THE HOST CLUB IS IN ITS OWN UNION (2026-09-10). A tournament hosted BY a' || E'\n' ||
         '     union has club_id = union_id, and that house club is never a row in' || E'\n' ||
         '     union_clubs. The membership test below joined union_clubs, so the' || E'\n' ||
         '     tournament''s own club could never be the preferred club - a satellite' || E'\n' ||
         '     winner who IS a member of the host club was resolved to some other club' || E'\n' ||
         '     and the ticket award was refused for a club mismatch. Friday Night' || E'\n' ||
         '     Feature Satellite Heads-Up sat RUNNING for 16 hours on that refusal. The' || E'\n' ||
         '     host club counts as in the union without needing the row. */' || E'\n' ||
         '  IF p_preferred_club IS NOT NULL' || E'\n' ||
         '     AND EXISTS (SELECT 1 FROM club_members m' || E'\n' ||
         '                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club' || E'\n' ||
         '                   AND m.status IN (''active'',''approved'')' || E'\n' ||
         '                   AND (m.club_id = v_t_club' || E'\n' ||
         '                        OR EXISTS (SELECT 1 FROM union_clubs uc' || E'\n' ||
         '                                    WHERE uc.club_id = m.club_id AND uc.union_id = v_union)))' || E'\n' ||
         '  THEN';
  v_new := replace(v_src, v_a, v_b);
  IF v_new = v_src THEN RAISE EXCEPTION 'substitution produced no change'; END IF;
  EXECUTE v_new;

  v_check := public.fn_tournament_club_for_user(
    '9da2d0b7-436d-4e47-826e-4c30077428a4',
    (SELECT satellite_target_id FROM public.tournaments WHERE id='9fee70de-c692-48fb-a423-98d730ab02bc'),
    'fade0000-0000-0000-0000-000000000001');
  IF v_check IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'post-condition failed: resolver still returns % for the stuck satellite winner. Nothing written.', v_check;
  END IF;

  RAISE NOTICE 'host club resolves as its own preferred club';
END $mig$;
