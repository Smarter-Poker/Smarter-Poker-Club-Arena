\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.rake_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hand_id uuid,
  table_id uuid,
  club_id uuid,
  rake_amount numeric NOT NULL DEFAULT 0,
  bbj_contribution numeric DEFAULT 0,
  pot_size numeric,
  num_players integer,
  created_at timestamptz DEFAULT now(),
  player_contributions jsonb,
  global_hand_id bigint,
  is_tournament boolean NOT NULL DEFAULT false,
  tournament_id uuid,
  source text DEFAULT 'cash_game',
  metadata jsonb,
  rake_method text NOT NULL DEFAULT 'DEALT_EQUAL',
  returned_uncalled jsonb
);

CREATE TABLE public.rake_attributions (
  hand_id uuid NOT NULL,
  player_id uuid NOT NULL,
  weighted_rake_credit numeric NOT NULL,
  PRIMARY KEY (hand_id, player_id)
);

CREATE TABLE public.tournament_players (
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE public.rakeback_daily_user (
  club_id uuid NOT NULL,
  day date NOT NULL,
  user_id uuid NOT NULL,
  cents bigint NOT NULL,
  PRIMARY KEY (club_id, day, user_id)
);
CREATE INDEX rakeback_daily_user_club_user_day_idx
  ON public.rakeback_daily_user (club_id, user_id, day);

CREATE TABLE public.rakeback_daily_state (
  club_id uuid NOT NULL,
  day date NOT NULL,
  rows_seen bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day)
);

CREATE TABLE public.rakeback_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  rake_generated numeric DEFAULT 0,
  rakeback_rate numeric DEFAULT 0.10,
  rakeback_amount numeric DEFAULT 0,
  status text DEFAULT 'pending',
  paid_at timestamptz,
  created_at timestamptz DEFAULT now(),
  rakeback_earned numeric DEFAULT 0,
  total_rake_paid numeric DEFAULT 0,
  deferred_reason text,
  deferred_at timestamptz,
  defer_count integer NOT NULL DEFAULT 0,
  CONSTRAINT rakeback_periods_user_id_club_id_period_start_period_end_key
    UNIQUE (user_id, club_id, period_start, period_end)
);
ALTER TABLE public.rakeback_periods ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.rakeback_periods TO anon, authenticated;
CREATE POLICY rakeback_periods_update_own ON public.rakeback_periods
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.rakeback_period_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rakeback_period_id uuid NOT NULL
    REFERENCES public.rakeback_periods(id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.fn_allocate_rake_credits(
  p_amount numeric,
  p_contributions jsonb,
  p_method text DEFAULT 'WEIGHTED_CONTRIBUTED'
)
RETURNS TABLE(user_id uuid, credit numeric, weight numeric)
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH c AS (
    SELECT (k.key)::uuid AS uid,
           round((k.value)::numeric * 100)::bigint AS cc
      FROM jsonb_each(COALESCE(p_contributions, '{}'::jsonb)) k
     WHERE jsonb_typeof(k.value) = 'number'
       AND (k.value)::numeric > 0
       AND k.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ), t AS (
    SELECT COALESCE(sum(cc), 0)::bigint AS total,
           round(GREATEST(COALESCE(p_amount, 0), 0) * 100)::bigint AS amt,
           count(*)::bigint AS n
      FROM c
  ), weighted AS (
    SELECT c.uid, c.cc,
           (t.amt * c.cc) / t.total AS fl,
           (t.amt * c.cc) % t.total AS rem,
           t.amt, t.total
      FROM c CROSS JOIN t
     WHERE t.total > 0
  ), weighted_ranked AS (
    SELECT w.*,
           row_number() OVER (ORDER BY w.rem DESC, w.uid ASC) AS rn,
           sum(w.fl) OVER () AS fl_sum
      FROM weighted w
  ), equal_ranked AS (
    SELECT c.uid, c.cc, t.amt, t.total, t.n,
           row_number() OVER (ORDER BY c.uid ASC) AS rn
      FROM c CROSS JOIN t
     WHERE t.n > 0
  )
  SELECT uid,
         ((fl + CASE WHEN rn <= (amt - fl_sum) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM weighted_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'WEIGHTED_CONTRIBUTED'
  UNION ALL
  SELECT uid,
         (((amt / n) + CASE WHEN rn <= (amt % n) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM equal_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'DEALT_EQUAL'
$function$;

CREATE OR REPLACE FUNCTION public.fn_rake_record_is_ghost_twin(
  p_hand_id uuid,
  p_table_id uuid,
  p_metadata jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT p_hand_id IS NULL
     AND p_table_id IS NOT NULL
     AND COALESCE(p_metadata->>'hand_number', '') ~ '^[0-9]{1,18}$'
     AND (p_metadata->>'hand_number')::bigint >= 1000000
     AND EXISTS (
       SELECT 1 FROM public.rake_records l
        WHERE l.table_id = p_table_id
          AND l.hand_id IS NOT NULL
          AND l.metadata->>'hand_number' = p_metadata->>'hand_number'
     )
$function$;

-- This BEFORE INSERT dependency is deliberately present in the isolated
-- schema: future positive tournament fees must name their player before the
-- rakeback AFTER INSERT trigger sees the source row.
CREATE OR REPLACE FUNCTION public.fn_tournament_fee_names_its_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := NEW.metadata->>'user_id';
  v_pc  jsonb;
BEGIN
  IF v_uid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    NEW.player_contributions := jsonb_build_object(v_uid, NEW.rake_amount);
  ELSIF NEW.tournament_id IS NOT NULL THEN
    SELECT jsonb_object_agg(tp.user_id::text, NEW.rake_amount) INTO v_pc
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.tournament_id AND tp.user_id IS NOT NULL;
    IF v_pc IS NOT NULL THEN
      NEW.player_contributions := v_pc;
    END IF;
  END IF;
  IF NEW.player_contributions IS NOT NULL THEN
    NEW.rake_method := COALESCE(NEW.rake_method, 'DEALT_EQUAL');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_tournament_fee_names_its_player
  BEFORE INSERT ON public.rake_records
  FOR EACH ROW
  WHEN (NEW.is_tournament IS TRUE AND NEW.player_contributions IS NULL AND NEW.rake_amount > 0)
  EXECUTE FUNCTION public.fn_tournament_fee_names_its_player();

CREATE OR REPLACE FUNCTION public.fn_player_rakeback_rate(
  p_user_id uuid,
  p_club_id uuid,
  p_total_rake numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
    WHEN p_user_id = '20000000-0000-4000-8000-000000000018'::uuid
      THEN 0::numeric
    ELSE 0.10::numeric
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_day(
  p_club_id uuid,
  p_day date,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows bigint;
  v_written integer;
BEGIN
  SELECT count(*) INTO v_rows
    FROM public.rake_records r
   WHERE r.club_id = p_club_id
     AND r.created_at >= p_day::timestamptz
     AND r.created_at < (p_day + 1)::timestamptz
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata);

  DELETE FROM public.rakeback_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH shares AS (
    SELECT a.user_id, round(a.credit * 100)::bigint AS cents
      FROM public.rake_records r
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        r.rake_amount,
        r.player_contributions,
        COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) a
     WHERE r.club_id = p_club_id
       AND r.created_at >= p_day::timestamptz
       AND r.created_at < (p_day + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
  ), ins AS (
    INSERT INTO public.rakeback_daily_user (club_id, day, user_id, cents)
    SELECT p_club_id, p_day, user_id, sum(cents)
      FROM shares
     GROUP BY user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  INSERT INTO public.rakeback_daily_state (club_id, day, rows_seen, computed_at)
  VALUES (p_club_id, p_day, v_rows, clock_timestamp())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_seen = EXCLUDED.rows_seen,
        computed_at = EXCLUDED.computed_at;

  RETURN jsonb_build_object(
    'written', v_written, 'fresh', false, 'rows_seen', v_rows, 'force', p_force
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid,
  p_period_start date,
  p_period_end date,
  p_user_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object('written', 0)
$function$;

-- The migration patches these two audited production functions by asserted
-- anchors.  The isolated probe only needs their accounting/relink surfaces;
-- the runner substitutes the fixture MD5s into a temporary migration copy.
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period record;
  v_rake_total numeric;
  v_rate numeric;
  v_payout numeric;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;
  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status);
  END IF;
  SELECT round(COALESCE(sum(d.cents), 0)::numeric / 100, 2)
    INTO v_rake_total
    FROM public.rakeback_daily_user d
   WHERE d.club_id = v_period.club_id
     AND d.user_id = v_period.user_id
     AND d.day BETWEEN v_period.period_start AND v_period.period_end;
  v_rate := public.fn_player_rakeback_rate(
    v_period.user_id, v_period.club_id, v_rake_total
  );
  v_payout := round(v_rake_total * v_rate, 2);
  UPDATE public.rakeback_periods
     SET rake_generated = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;
  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = clock_timestamp()
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'payout', 0);
  END IF;
  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = clock_timestamp()
   WHERE id = p_period_id;
  RETURN jsonb_build_object('success', true, 'payout', v_payout);
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_relink_rake_record_to_hand(
  p_table_id uuid,
  p_hand_number bigint,
  p_hand_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_linked int;
begin
  update public.rake_records r
     set hand_id = p_hand_id
   where r.id = (
     select id from public.rake_records
      where table_id = p_table_id
        and hand_id is null
        and metadata->>'hand_number' = p_hand_number::text
      order by created_at, id limit 1 for update skip locked
   )
     and r.hand_id is null;
  get diagnostics v_linked = row_count;
  return v_linked;
end
$function$;

INSERT INTO public.rake_records (
  id, hand_id, table_id, club_id, rake_amount, created_at,
  player_contributions, is_tournament, tournament_id, source, metadata, rake_method
) VALUES
  ('50000000-0000-4000-8000-000000000100',
   '40000000-0000-4000-8000-000000000100',
   '30000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 0.50,
   '2026-09-01 01:00:00+00',
   '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
   false, NULL, 'pre_epoch', '{"hand_number":999999}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000101',
   '40000000-0000-4000-8000-000000000101',
   '30000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 1.01,
   '2026-09-08 01:00:00+00',
   '{"20000000-0000-4000-8000-000000000001":10,"20000000-0000-4000-8000-000000000002":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000001',
   'fn_register_for_tournament',
   '{"hand_number":1000000,"user_id":"20000000-0000-4000-8000-000000000001"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000102', NULL,
   '30000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 2.00,
   '2026-09-08 02:00:00+00',
   '{"20000000-0000-4000-8000-000000000001":10,"20000000-0000-4000-8000-000000000002":10}'::jsonb,
   false, NULL, 'legacy_ghost', '{"hand_number":1000001}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000103',
   '40000000-0000-4000-8000-000000000103',
   '30000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 2.00,
   '2026-09-08 02:00:01+00',
   '{"20000000-0000-4000-8000-000000000001":10,"20000000-0000-4000-8000-000000000002":10}'::jsonb,
   false, NULL, 'linked', '{"hand_number":1000001}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000104',
   '40000000-0000-4000-8000-000000000104',
   '30000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', 1.00,
   '2026-09-08 03:00:00+00', '{}'::jsonb,
   false, NULL, 'empty', '{"hand_number":1000002}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000105',
   '40000000-0000-4000-8000-000000000105',
   '30000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000002', 1.00,
   '2026-09-08 04:00:00+00',
   '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
   false, NULL, 'stale_one', '{"hand_number":1000003}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000106',
   '40000000-0000-4000-8000-000000000106',
   '30000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000002', 1.00,
   '2026-09-08 05:00:00+00',
   '{"20000000-0000-4000-8000-000000000001":10}'::jsonb,
   false, NULL, 'stale_two', '{"hand_number":1000004}'::jsonb, 'DEALT_EQUAL'),
  -- A pre-existing tournament refund whose original week was already paid.
  -- The legacy daily rebuild ignored negative rake, so cutover must preserve
  -- the paid row and post this exact reversal into the current open week.
  ('50000000-0000-4000-8000-000000000107', NULL,
   '30000000-0000-4000-8000-000000000013',
   '10000000-0000-4000-8000-000000000013', 4.00,
   '2026-09-01 06:00:00+00',
   '{"20000000-0000-4000-8000-000000000014":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000013',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","registration_id":"cutover-paid-origin","user_id":"20000000-0000-4000-8000-000000000014"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000108', NULL,
   '30000000-0000-4000-8000-000000000013',
   '10000000-0000-4000-8000-000000000013', -4.00,
   '2026-09-08 06:00:00+00', NULL,
   true, '60000000-0000-4000-8000-000000000013',
   'fn_unregister_from_tournament',
   '{"kind":"tournament_fee_refund","original_rake_record_id":"50000000-0000-4000-8000-000000000107","registration_id":"cutover-paid-origin","user_id":"20000000-0000-4000-8000-000000000014"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000109', NULL,
   '30000000-0000-4000-8000-000000000014',
   '10000000-0000-4000-8000-000000000014', 0.80,
   '2026-09-01 07:00:00+00',
   '{"20000000-0000-4000-8000-000000000015":10}'::jsonb,
   false, NULL, 'pre_epoch_relink', '{"hand_number":900109}'::jsonb,
   'DEALT_EQUAL'),
  -- This future event has a fee in an already-paid pre-cutover week but no
  -- refund yet. A lawful post-cutover unregister must still commit later.
  ('50000000-0000-4000-8000-000000000110', NULL,
   '30000000-0000-4000-8000-000000000015',
   '10000000-0000-4000-8000-000000000015', 6.00,
   '2026-09-01 08:00:00+00',
   '{"20000000-0000-4000-8000-000000000016":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000015',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","registration_id":"pre-cutover-paid-future-refund","user_id":"20000000-0000-4000-8000-000000000016"}'::jsonb,
   'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000111', NULL,
   '30000000-0000-4000-8000-000000000016',
   '10000000-0000-4000-8000-000000000016', 7.00,
   '2026-09-01 09:00:00+00',
   '{"20000000-0000-4000-8000-000000000017":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000016',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","registration_id":"pre-cutover-paid-future-delete","user_id":"20000000-0000-4000-8000-000000000017"}'::jsonb,
   'DEALT_EQUAL'),
  -- The player had a paid deal in the source week but now resolves to a zero
  -- rate. Their refund debt still needs an open period and durable carry.
  ('50000000-0000-4000-8000-000000000112', NULL,
   '30000000-0000-4000-8000-000000000017',
   '10000000-0000-4000-8000-000000000017', 8.00,
   '2026-09-01 10:00:00+00',
   '{"20000000-0000-4000-8000-000000000018":10}'::jsonb,
   true, '60000000-0000-4000-8000-000000000017',
   'fn_register_for_tournament',
   '{"kind":"tournament_fee","registration_id":"pre-cutover-paid-zero-rate-refund","user_id":"20000000-0000-4000-8000-000000000018"}'::jsonb,
   'DEALT_EQUAL'),
  -- One cent split across six dealt players yields one positive receipt and
  -- five legitimate zero-cent receipts.  The paid historical DELETE path
  -- must classify the positive-receipt population, not the allocator's six
  -- rows, or it will omit the one cent that belongs in the open offset.
  ('50000000-0000-4000-8000-000000000113',
   '40000000-0000-4000-8000-000000000113',
   '30000000-0000-4000-8000-000000000018',
   '10000000-0000-4000-8000-000000000018', 0.01,
   '2026-09-01 11:00:00+00',
   '{"20000000-0000-4000-8000-000000000020":10,"20000000-0000-4000-8000-000000000021":10,"20000000-0000-4000-8000-000000000022":10,"20000000-0000-4000-8000-000000000023":10,"20000000-0000-4000-8000-000000000024":10,"20000000-0000-4000-8000-000000000025":10}'::jsonb,
   false, NULL, 'pre_cutover_paid_low_cent_delete',
   '{"hand_number":900113}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000114',
   '40000000-0000-4000-8000-000000000114',
   '30000000-0000-4000-8000-000000000019',
   '10000000-0000-4000-8000-000000000019', 0.01,
   '2026-09-08 05:30:00+00',
   '{"20000000-0000-4000-8000-000000000019":10}'::jsonb,
   false, NULL, 'legacy_divergent_end_period',
   '{"hand_number":1000114}'::jsonb, 'DEALT_EQUAL'),
  ('50000000-0000-4000-8000-000000000115',
   '40000000-0000-4000-8000-000000000115',
   '30000000-0000-4000-8000-000000000020',
   '10000000-0000-4000-8000-000000000020', 0.01,
   '2026-09-08 05:31:00+00',
   '{"20000000-0000-4000-8000-000000000019":10}'::jsonb,
   false, NULL, 'legacy_cross_club_period',
   '{"hand_number":1000115}'::jsonb, 'DEALT_EQUAL');

-- Club one is an old raw witness: it includes the ghost and empty-object row.
INSERT INTO public.rakeback_daily_user (club_id, day, user_id, cents) VALUES
  ('10000000-0000-4000-8000-000000000001', '2026-09-08',
   '20000000-0000-4000-8000-000000000001', 251),
  ('10000000-0000-4000-8000-000000000001', '2026-09-08',
   '20000000-0000-4000-8000-000000000002', 250),
  ('10000000-0000-4000-8000-000000000002', '2026-09-08',
   '20000000-0000-4000-8000-000000000001', 100);

INSERT INTO public.rakeback_daily_state (club_id, day, rows_seen) VALUES
  ('10000000-0000-4000-8000-000000000001', '2026-09-08', 4),
  ('10000000-0000-4000-8000-000000000002', '2026-09-08', 1);

INSERT INTO public.rakeback_periods (
  user_id, club_id, period_start, period_end,
  rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
  total_rake_paid, status
) VALUES
  ('20000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000001', '2026-09-07', '2026-09-13',
   999, 0.10, 99.90, 99.90, 999, 'pending'),
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', '2026-09-07', '2026-09-13',
   999, 0.10, 99.90, 99.90, 999, 'pending'),
  ('20000000-0000-4000-8000-000000000014',
   '10000000-0000-4000-8000-000000000013', '2026-08-31', '2026-09-06',
   4.00, 0.10, 0.40, 0.40, 4.00, 'paid'),
  ('20000000-0000-4000-8000-000000000016',
   '10000000-0000-4000-8000-000000000015', '2026-08-31', '2026-09-06',
   6.00, 0.10, 0.60, 0.60, 6.00, 'paid'),
  ('20000000-0000-4000-8000-000000000017',
   '10000000-0000-4000-8000-000000000016', '2026-08-31', '2026-09-06',
   7.00, 0.10, 0.70, 0.70, 7.00, 'paid'),
  ('20000000-0000-4000-8000-000000000018',
   '10000000-0000-4000-8000-000000000017', '2026-08-31', '2026-09-06',
   8.00, 0.10, 0.80, 0.80, 8.00, 'paid'),
  ('20000000-0000-4000-8000-000000000020',
   '10000000-0000-4000-8000-000000000018', '2026-08-31', '2026-09-06',
   0.01, 0.10, 0.00, 0.00, 0.01, 'paid'),
  -- Production contains one legacy pair of pending rows for the same
  -- player/club/week with different end dates. The cutover must retain one
  -- canonical pending projection and remove only the redundant projection.
  ('20000000-0000-4000-8000-000000000026',
   '10000000-0000-4000-8000-000000000021', '2026-09-07', '2026-09-07',
   0.66, 0.10, 0.07, 0.07, 0.66, 'pending'),
  ('20000000-0000-4000-8000-000000000026',
   '10000000-0000-4000-8000-000000000021', '2026-09-07', '2026-09-13',
   1.44, 0.10, 0.14, 0.14, 1.44, 'pending'),
  -- Paid evidence may keep a historical one-day end. Recompute must preserve
  -- it and may create an independent pending projection when new basis exists.
  ('20000000-0000-4000-8000-000000000019',
   '10000000-0000-4000-8000-000000000019', '2026-09-07', '2026-09-07',
   0.01, 0.10, 0.00, 0.00, 0.01, 'paid');

-- Same player/week in another club proves the pending identity is club scoped.
-- It must not move or normalize the paid first-club row.
INSERT INTO public.rakeback_daily_user (club_id, day, user_id, cents) VALUES
  ('10000000-0000-4000-8000-000000000019', '2026-09-08',
   '20000000-0000-4000-8000-000000000019', 1),
  ('10000000-0000-4000-8000-000000000020', '2026-09-08',
   '20000000-0000-4000-8000-000000000019', 1);

INSERT INTO public.rakeback_daily_state (club_id, day, rows_seen) VALUES
  ('10000000-0000-4000-8000-000000000019', '2026-09-08', 1),
  ('10000000-0000-4000-8000-000000000020', '2026-09-08', 1);
