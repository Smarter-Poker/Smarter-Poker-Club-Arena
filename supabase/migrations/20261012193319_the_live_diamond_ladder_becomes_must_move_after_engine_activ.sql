-- ACTIVATE ONLY AFTER the qualified engine accepting Diamond must-move is live.
-- Adoption does not write any seat, wallet, custody balance or money journal.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

DO $adopt$
DECLARE a uuid; t public.tables%ROWTYPE;
BEGIN
 SELECT club_id INTO STRICT a FROM public.ca_arena_settings WHERE id=1;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'diamond_adoption_platform_frozen'; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_games WHERE club_id=a) THEN
  RAISE EXCEPTION 'diamond_must_move_adoption_already_started';
 END IF;
 FOR t IN SELECT * FROM public.tables WHERE club_id=a AND tournament_id IS NULL
   AND status IN('waiting','running','playing','active') AND NOT coalesce(is_deleted,false)
   ORDER BY id FOR UPDATE
 LOOP
  IF t.cluster_id IS NOT NULL OR NOT public.fn_poker_diamond_plain_cash_table(t) THEN
   RAISE EXCEPTION 'diamond_adoption_table_scope: %',t.id;
  END IF;
  PERFORM public.fn_poker_diamond_attach_cash_game(t.id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.tables WHERE club_id=a AND tournament_id IS NULL
   AND status IN('waiting','running','playing','active') AND NOT coalesce(is_deleted,false)
   AND cluster_id IS NULL) THEN RAISE EXCEPTION 'diamond_must_move_ladder_incomplete'; END IF;
END;
$adopt$;
COMMIT;
