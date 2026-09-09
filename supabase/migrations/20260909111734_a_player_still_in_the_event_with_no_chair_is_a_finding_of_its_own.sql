/* WHY. fn_tournament_chip_conservation_check has been reporting the same
   seven running events since 2026-09-02 as a single number each - "drift
   -296,000" - which tells an operator that chips are missing and nothing
   about where. The check itself is sound: 47 of the platform's 54 running
   events balance to the chip, including a 200 player free buy at 2,630,000
   exactly, so the expectation is right and the seven are real.

   Measuring the seven showed what the number was hiding. In three of them the
   missing chips are, to the chip, the last recorded stacks of players who are
   still alive on the roster and hold no open seat at any table:

     Midday Free Buy       drift -296,000   stranded 296,000   exact
     Prime Time Main Event drift -420,000   stranded 370,000
     Early Bird Freeroll   drift  -40,000   stranded   2,500

   Those players are not a rounding artefact. They are stuck: in the event,
   holding chips, at no table, unable to be dealt a hand, and invisible to
   every reader that counts chips at open seats. That is a player-facing
   fault, and it deserves a name and a number of its own rather than being
   folded into an aggregate that says only that something does not add up.

   This does not close the conservation finding and is not meant to: the
   largest event, the 6:00 AM freeroll, has both its survivors seated and its
   2,868,800 is NOT stranded players. That part stays open and unexplained,
   which is the honest state of it. What this does is stop the two questions
   being asked as one. */
CREATE OR REPLACE FUNCTION public.fn_ca_stranded_tournament_players()
RETURNS TABLE(tournament_id uuid, tournament_name text, stranded_players bigint,
              stranded_chips numeric, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH stranded AS (
    SELECT t.id, t.name, p.user_id,
           (SELECT s.stack
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
             ORDER BY s.left_at DESC NULLS FIRST
             LIMIT 1) AS last_stack
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status <> 'eliminated'
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
  )
  SELECT s.id, s.name, count(*), round(sum(s.last_stack), 2),
         count(*) || ' player(s) are still in this event holding '
           || round(sum(s.last_stack), 2) || ' chips and are seated at no table, so they '
           || 'cannot be dealt a hand and their chips are outside every reader that '
           || 'counts open seats' AS detail
    FROM stranded s
   WHERE COALESCE(s.last_stack, 0) > 0
   GROUP BY s.id, s.name
   ORDER BY 4 DESC
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_stranded_tournament_players() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_stranded_tournament_players() FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_stranded_tournament_players() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_stranded_tournament_players() TO service_role;

DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position($chk$fn_ca_stranded_tournament_players$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the sweep already runs the stranded-player check';
  END IF;
  IF position($chk$      ('fn_ca_undeclared_leg_check',$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep roster moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning')$old$,
$new$      ('fn_ca_undeclared_leg_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_undeclared_leg_check(24) limit 20) t',
       'warning'),
      ('fn_ca_stranded_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_stranded_tournament_players() limit 20) t',
       'warning')$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'the sweep roster was not extended'; END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$fn_ca_stranded_tournament_players$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep') = 0 THEN
    RAISE EXCEPTION 'the sweep did not take the stranded-player check';
  END IF;
END
$mig$;;
