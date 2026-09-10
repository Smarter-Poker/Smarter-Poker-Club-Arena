-- Catalog column types observed on 2026-09-10. These are read shapes only:
-- table/hand/escrow/seat transition writers and their production trigger graph
-- are deliberately not modelled by this fixture.
ALTER TABLE public.spin_bonus_pools ADD COLUMN id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.chip_ledger ADD COLUMN post_from_balance numeric,
  ADD COLUMN post_to_balance numeric;
ALTER TABLE public.tournament_players ADD COLUMN chips integer,
  ADD COLUMN table_id uuid, ADD COLUMN seat_number integer;
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid, status text,
  created_at timestamptz DEFAULT now(), current_players integer, max_players integer);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid, user_id uuid, seat_number integer, stack numeric(15,2), left_at timestamptz);
CREATE TABLE public.hand_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid, table_id uuid, created_at timestamptz);

-- Controlled evidence INPUTS for the actual installed read-only proof. Existing
-- entry/draw rows and immutable receipt come from the funding probe. The journal,
-- escrow, hand, roster and seat inputs below do not claim to run their writers.
CREATE FUNCTION public.probe_played_spin_evidence(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $fixture$
DECLARE v_draw public.spin_reserve_ledger%ROWTYPE;
  v_entry public.spin_reserve_ledger%ROWTYPE; v_pool uuid; v_stack integer;
BEGIN
  SELECT * INTO STRICT v_draw FROM public.spin_reserve_ledger
    WHERE tournament_id=p_id AND kind='jackpot_draw';
  SELECT * INTO STRICT v_entry FROM public.spin_reserve_ledger
    WHERE tournament_id=p_id AND kind='contribution';
  SELECT id INTO STRICT v_pool FROM public.spin_bonus_pools WHERE club_id=v_draw.club_id;
  SELECT starting_chips INTO STRICT v_stack FROM public.tournaments WHERE id=p_id;
  UPDATE public.spin_reserve_ledger
    SET balance_after=v_draw.balance_after-v_draw.amount
    WHERE id=v_entry.id;
  INSERT INTO public.chip_ledger(id,club_id,tournament_id,category,amount,
    from_type,from_entity_id,to_type,to_entity_id,post_to_balance)
    VALUES(gen_random_uuid(),v_entry.club_id,p_id,'spin_entry',v_entry.amount,
      'prize_liability',p_id,'spin_reserve',v_pool,v_draw.balance_after-v_draw.amount);
  INSERT INTO public.chip_ledger(id,club_id,tournament_id,category,amount,
    from_type,from_entity_id,to_type,to_entity_id,post_from_balance)
    VALUES(gen_random_uuid(),v_draw.club_id,p_id,'spin_prize',-v_draw.amount,
      'spin_reserve',v_pool,'prize_liability',p_id,v_draw.balance_after);
  UPDATE public.tournament_escrow SET reserve_out=v_entry.amount,
    reserve_in=-v_draw.amount,prize_balance=-v_draw.amount WHERE tournament_id=p_id;
  INSERT INTO public.tables(id,tournament_id,status,current_players,max_players)
    VALUES(p_id,p_id,'running',2,3);
  WITH numbered AS (
    SELECT id,row_number() OVER(ORDER BY id)::integer seat
      FROM public.tournament_players WHERE tournament_id=p_id
  ) UPDATE public.tournament_players tp SET
    status=CASE WHEN n.seat=1 THEN 'eliminated' ELSE 'playing' END,
    chips=CASE n.seat WHEN 1 THEN 0 WHEN 2 THEN v_stack ELSE v_stack*2 END,
    table_id=CASE WHEN n.seat=1 THEN NULL ELSE p_id END,
    seat_number=CASE WHEN n.seat=1 THEN NULL ELSE n.seat END
    FROM numbered n WHERE tp.id=n.id;
  INSERT INTO public.table_seats(table_id,user_id,seat_number,stack,left_at)
    SELECT p_id,user_id,row_number() OVER(ORDER BY id),chips,
      CASE WHEN status='eliminated' THEN clock_timestamp() ELSE NULL END
    FROM public.tournament_players WHERE tournament_id=p_id;
  INSERT INTO public.hand_history(tournament_id,table_id,created_at)
    VALUES(p_id,p_id,clock_timestamp());
END;
$fixture$;
