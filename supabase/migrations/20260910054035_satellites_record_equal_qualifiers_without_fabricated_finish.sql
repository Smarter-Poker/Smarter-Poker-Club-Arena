-- Forward-only expansion. Deploy DB first, then qualification-aware engine/UI.
-- No historical standings or payments are rewritten. Exact K, zero remainder
-- is the only new policy branch; threshold ties and leftover awards remain open.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

DO $qualification_lease_gate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)','d1b5100c2b9f92bec5fd1680b0b4f230'),
      ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)','5e6c99545e07c21efcb50e5cb3441c14')
    ) expected(signature,body_md5)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR md5(p.prosrc) IS DISTINCT FROM expected.body_md5
       OR p.proowner IS DISTINCT FROM 'postgres'::regrole
       OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
       OR p.prosecdef IS DISTINCT FROM true
       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'qualification preparation requires the reviewed takeover fence and compatible heartbeat'
      USING ERRCODE='55000';
  END IF;
END;
$qualification_lease_gate$;

DO $source_gate$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
        'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'))
         IS DISTINCT FROM '83bf8b297d07bbae671707f24afec271'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
        'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'))
         IS DISTINCT FROM '381b3e0691a2b9303693653f5110d568'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
        'public.fn_rank_survivors(uuid)'))
         IS DISTINCT FROM 'db9fa6b2c0fbd4e5e4f4ba804722a75c'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
        'public.fn_settle_satellite_tournament(uuid,uuid)'))
         IS DISTINCT FROM '6babe5451efa9bc2bfa12cb0fede27e2' THEN
    RAISE EXCEPTION 'qualification expansion requires the reviewed money core, receipt, and final seat wrapper';
  END IF;
  IF to_regprocedure('public.fn_settle_satellite_tournament_seat_exit_core_v2(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_close_tournament_seat_exit_authority(uuid,boolean)') IS NULL
     OR to_regprocedure('public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'qualification expansion requires the separately verified final seat authority';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
        'public.fn_guard_tournament_completing_claim()'))
       IS DISTINCT FROM '619bf63e5c77c29400de480a882b9322'
     OR (SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
          AND tgname='aa_guard_tournament_completing_claim') IS DISTINCT FROM 'D'::"char" THEN
    RAISE EXCEPTION 'qualification expansion requires the reviewed completion claim guard';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid='public.tournament_satellite_settlements'::regclass
         AND contype='c' AND pg_get_constraintdef(oid) LIKE '%receipt_version%')<>1
     OR (SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint
       WHERE conrelid='public.tournament_satellite_settlements'::regclass
         AND conname='tournament_satellite_settlements_receipt_version_check')
       IS DISTINCT FROM '959657529dd9e22479607b32a4837231' THEN
    RAISE EXCEPTION 'qualification expansion requires the exact reviewed version-two constraint';
  END IF;
  IF has_function_privilege('anon','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_settle_satellite_tournament(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_ca_satellite_settlement_receipt(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_satellite_settlement_receipt(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.fn_ca_satellite_settlement_receipt(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'qualification expansion requires the reviewed private receipt and engine-only wrapper ACLs';
  END IF;
END;
$source_gate$;

ALTER TABLE public.tournament_satellite_settlements
  ADD COLUMN completion_kind text NOT NULL DEFAULT 'single_winner',
  ALTER COLUMN winner_id DROP NOT NULL;
ALTER TABLE public.tournament_satellite_settlements
  DROP CONSTRAINT tournament_satellite_settlements_receipt_version_check;
ALTER TABLE public.tournament_satellite_settlements
  ADD CONSTRAINT satellite_completion_kind_version CHECK (
    (completion_kind='single_winner' AND receipt_version=2 AND winner_id IS NOT NULL)
    OR (completion_kind='equal_qualifiers' AND receipt_version=3 AND winner_id IS NULL
        AND ticket_award_count>=2 AND remainder=0));

-- This intent is written only after the engine parked all source dealers.
-- COMPLETING prevents restart admission and accepted hand writers from
-- consuming another qualifying stack while the same atomic payer retries.
CREATE TABLE public.tournament_satellite_qualification_boundaries(
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  qualified_user_ids uuid[] NOT NULL CHECK(cardinality(qualified_user_ids)>=2),
  lease_generation uuid NOT NULL,
  qualified_stacks jsonb NOT NULL CHECK(jsonb_typeof(qualified_stacks)='object'),
  source_table_ids uuid[] NOT NULL CHECK(cardinality(source_table_ids)>0),
  source_seat_ids uuid[] NOT NULL CHECK(cardinality(source_seat_ids)>=2),
  qualified_at timestamptz NOT NULL
);
ALTER TABLE public.tournament_satellite_qualification_boundaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_qualification_boundaries
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.tournament_satellite_qualification_boundaries TO service_role;
CREATE TRIGGER satellite_qualification_boundaries_are_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_satellite_qualification_boundaries
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();

CREATE TABLE public.tournament_satellite_qualifiers(
  tournament_id uuid NOT NULL REFERENCES public.tournament_satellite_settlements(tournament_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  user_id uuid NOT NULL,
  registration_id uuid NOT NULL REFERENCES public.tournament_players(id) ON DELETE RESTRICT,
  award_ordinal integer NOT NULL CHECK (award_ordinal>0),
  qualified_chips numeric NOT NULL CHECK (
    qualified_chips>0 AND qualified_chips::text NOT IN ('NaN','Infinity','-Infinity')),
  qualified_at timestamptz NOT NULL,
  PRIMARY KEY(tournament_id,user_id),
  UNIQUE(tournament_id,award_ordinal),
  UNIQUE(registration_id)
);
COMMENT ON COLUMN public.tournament_satellite_qualifiers.award_ordinal IS
  'Deterministic payment line identity within an equal-value cohort, never a finishing rank.';
COMMENT ON TABLE public.tournament_satellite_qualifiers IS
  'Immutable exact-K equal-prize qualification. Source winner status means qualified; position remains NULL.';
ALTER TABLE public.tournament_satellite_qualifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_satellite_qualifiers FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.tournament_satellite_qualifiers TO authenticated,service_role;
CREATE POLICY satellite_qualifier_reads_own_receipt ON public.tournament_satellite_qualifiers
  FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE TRIGGER satellite_qualifiers_are_append_only
  BEFORE UPDATE OR DELETE ON public.tournament_satellite_qualifiers
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();

CREATE FUNCTION public.fn_ca_satellite_award_ordinal(p_tournament_id uuid,p_user_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $ordinal$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public.tournament_satellite_qualifiers cohort
     WHERE cohort.tournament_id=p_tournament_id)
    THEN q.award_ordinal ELSE tp.position END
    FROM public.tournament_players tp
    LEFT JOIN public.tournament_satellite_qualifiers q
      ON q.tournament_id=tp.tournament_id AND q.user_id=tp.user_id
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id;
$ordinal$;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_award_ordinal(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_settlement_receipt(p_tournament_id uuid, p_observed_winner_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_h public.tournament_satellite_settlements%ROWTYPE;
  v_source record;
  v_target record;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_rake_settlement record;
  v_field_size integer;
  v_position_count integer;
  v_rows integer;
  v_expected_rows integer;
  v_amount numeric;
  v_rake numeric;
  v_awards jsonb := '[]'::jsonb;
  v_seats jsonb := '[]'::jsonb;
  v_remainder jsonb := NULL;
  v_winner_amount numeric := 0;
  v_source_table_ids uuid[];
  v_source_seat_ids uuid[];
  v_durable_released_ids uuid[];
  v_durable_released_count integer;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'satellite receipt requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_h
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'satellite % has no immutable settlement header',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_h.winner_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'satellite % receipt winner % differs from observed winner %',
      p_tournament_id, v_h.winner_id, p_observed_winner_id
      USING ERRCODE = '40001';
  END IF;
  IF NOT ((v_h.receipt_version=2 AND v_h.completion_kind='single_winner'
            AND v_h.winner_id IS NOT NULL)
       OR (v_h.receipt_version=3 AND v_h.completion_kind='equal_qualifiers'
            AND v_h.winner_id IS NULL AND v_h.ticket_award_count>=2 AND v_h.remainder=0)) THEN
    RAISE EXCEPTION 'satellite % has unsupported receipt version %',
      p_tournament_id, v_h.receipt_version USING ERRCODE = 'P0404';
  END IF;

  -- Target lifecycle state is intentionally absent from replay. A target may
  -- close after commit without changing what was already delivered.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_h.target_id)
   ORDER BY CASE WHEN t.id = v_h.target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.ended_at,
         t.current_players, t.on_break, t.break_started_at, t.break_ends_at
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'satellite % source row is missing',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_source.status, '')) <> 'COMPLETED'
     OR COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE
     OR v_source.ended_at IS NULL
     OR v_source.ended_at IS DISTINCT FROM v_h.source_closed_at
     OR v_source.current_players IS DISTINCT FROM 0
     OR v_source.on_break IS DISTINCT FROM false
     OR v_source.break_started_at IS NOT NULL
     OR v_source.break_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'satellite % receipt is not attached to one completed close',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % no longer identifies as a satellite',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF COALESCE(v_source.satellite_target_id, v_source.satellite_target)
       IS DISTINCT FROM v_h.target_id
     OR v_source.prize_pool IS NULL
     OR v_source.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR round(v_source.prize_pool, 2) IS DISTINCT FROM v_h.pool
     OR COALESCE(v_source.satellite_seats, 0) IS DISTINCT FROM v_h.advertised_seats
     OR v_h.pool < v_h.advertised_seats * v_h.ticket_cost
     OR floor(v_h.pool / v_h.ticket_cost)::integer IS DISTINCT FROM v_h.ticket_award_count
     OR round(v_h.pool - v_h.ticket_award_count * v_h.ticket_cost, 2)
          IS DISTINCT FROM v_h.remainder THEN
    RAISE EXCEPTION 'satellite % immutable receipt disagrees with its locked contract',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id,t.buy_in_amount,t.buy_in_fee,t.bounty_amount,t.is_bounty,
         t.is_pko,t.is_mystery_bounty,t.is_premium_spin,t.variant,
         t.tournament_type,t.club_id
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_h.target_id
   FOR SHARE;
  IF v_target.id IS NULL
     OR v_h.target_was_missing IS DISTINCT FROM false
     OR v_h.target_contract_version IS NOT NULL
     OR ((v_h.seat_count > 0 OR v_h.entry_ticket_count > 0) AND (
          v_target.buy_in_amount IS DISTINCT FROM v_h.target_buy_in
       OR COALESCE(v_target.buy_in_fee,0) IS DISTINCT FROM v_h.target_fee
       OR COALESCE(v_target.bounty_amount,0) <> 0
       OR COALESCE(v_target.is_bounty,false)
       OR COALESCE(v_target.is_pko,false)
       OR COALESCE(v_target.is_mystery_bounty,false)
       OR COALESCE(v_target.is_premium_spin,false)
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN')) THEN
    RAISE EXCEPTION 'satellite % immutable receipt lost its locked target row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- The header is the immutable settlement-time contract. Replay proves that
  -- exact value through its award, transfer and fee evidence. The terminal
  -- hardening migration also freezes the target's economic columns after its
  -- first actual seat, so cancellation and unregister use the same split.

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_h.target_id)
   ORDER BY tp.tournament_id, tp.id FOR SHARE;
  IF v_h.completion_kind='equal_qualifiers' THEN
    IF (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id)<>v_h.field_size
       OR (SELECT count(*) FROM public.tournament_satellite_qualifiers q
            WHERE q.tournament_id=p_tournament_id)<>v_h.ticket_award_count
       OR EXISTS (
         SELECT 1 FROM public.tournament_satellite_qualifiers q
         LEFT JOIN public.tournament_players tp ON tp.id=q.registration_id
          WHERE q.tournament_id=p_tournament_id
            AND (q.award_ordinal>v_h.ticket_award_count
              OR tp.id IS NULL OR tp.tournament_id IS DISTINCT FROM p_tournament_id
              OR tp.user_id IS DISTINCT FROM q.user_id
              OR tp.status::text IS DISTINCT FROM 'winner'
              OR tp.position IS NOT NULL OR tp.eliminated_at IS NOT NULL
              OR tp.elimination_sequence IS NOT NULL
              OR q.qualified_at IS DISTINCT FROM (
                SELECT b.qualified_at FROM public.tournament_satellite_qualification_boundaries b
                 WHERE b.tournament_id=p_tournament_id)))
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id
            AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_qualifiers q
                             WHERE q.tournament_id=p_tournament_id AND q.user_id=tp.user_id)
            AND tp.status::text IS DISTINCT FROM 'eliminated') THEN
      RAISE EXCEPTION 'satellite receipt has no exact durable equal-qualifier cohort'
        USING ERRCODE='P0404';
    END IF;
  ELSE
  SELECT count(*), count(DISTINCT tp.position)
    INTO v_field_size, v_position_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size <> v_h.field_size
     OR v_position_count <> v_h.field_size
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND (tp.position IS NULL OR tp.position < 1 OR tp.position > v_h.field_size)
    ) OR NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.user_id = v_h.winner_id
          AND tp.position = 1 AND tp.status::text = 'winner'
          AND tp.eliminated_at IS NULL
          AND tp.elimination_sequence IS NULL
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.position > 1
          AND tp.status::text IS DISTINCT FROM 'eliminated'
     ) THEN
    RAISE EXCEPTION 'satellite % receipt has no exact final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  END IF;

  -- A satellite is not terminal while its felt still owns live seats. The
  -- header freezes every source table and seat identity, plus the subset that
  -- this settlement itself released. Replay requires the exact same durable
  -- rows, every table closed at zero and no live seat left behind.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_source_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[])
    INTO v_durable_released_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND ts.left_at IS NOT DISTINCT FROM v_h.settled_at
     AND ts.status IS NOT DISTINCT FROM 'left'
     AND ts.leave_pending IS FALSE
     AND ts.is_sitting_out IS FALSE
     AND ts.is_away IS FALSE
     AND ts.sit_out_at IS NULL
     AND ts.scheduled_leave_hands IS NULL;
  v_durable_released_count := cardinality(v_durable_released_ids);
  IF v_source_table_ids IS DISTINCT FROM v_h.source_table_ids
     OR cardinality(v_source_table_ids) IS DISTINCT FROM v_h.source_table_count
     OR v_source_seat_ids IS DISTINCT FROM v_h.source_seat_ids
     OR cardinality(v_source_seat_ids) IS DISTINCT FROM v_h.source_seat_count
     OR v_durable_released_ids IS DISTINCT FROM v_h.released_seat_ids
     OR v_durable_released_count IS DISTINCT FROM v_h.released_seat_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0
            OR tb.terminal_closed_at IS DISTINCT FROM v_h.source_closed_at)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % source table or seat closeout differs from its immutable receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  IF v_rows <> v_h.ticket_award_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'seat')
          <> v_h.seat_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'cash')
          <> v_h.cash_ticket_count
     OR (SELECT count(*) FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id AND a.delivery_kind = 'ticket')
          <> v_h.entry_ticket_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
         JOIN public.tournament_players tp
           ON tp.tournament_id = p_tournament_id AND public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) = a.place
        WHERE a.tournament_id = p_tournament_id
          AND (a.place > v_h.ticket_award_count
            OR a.user_id IS DISTINCT FROM tp.user_id
            OR a.amount IS DISTINCT FROM v_h.ticket_cost)
     ) OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) BETWEEN 1 AND v_h.ticket_award_count
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_satellite_awards a
             WHERE a.tournament_id = p_tournament_id
               AND a.place = public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) AND a.user_id = tp.user_id)
     ) THEN
    RAISE EXCEPTION 'satellite % has incomplete or non-contiguous award lines',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Every line has one exact payout row. Cash lines additionally prove the
  -- wallet credit and closed obligation; seats prove the registration and
  -- source-to-target funding leg below.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id = a.payout_id
     WHERE a.tournament_id = p_tournament_id
       AND (p.id IS NULL
         OR p.tournament_id IS DISTINCT FROM p_tournament_id
         OR p.user_id IS DISTINCT FROM a.user_id
         OR p."position" IS DISTINCT FROM a.place
         OR p.amount IS DISTINCT FROM a.amount
         OR p.source IS DISTINCT FROM a.payout_source
         OR p.idempotency_key IS DISTINCT FROM a.idempotency_key)
  ) THEN
    RAISE EXCEPTION 'satellite % award line has no exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_obligations o ON o.id = a.obligation_id
      LEFT JOIN public.wallet_credit_idempotency k ON k.key = a.idempotency_key
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'cash'
       AND (o.id IS NULL
         OR o.tournament_id IS DISTINCT FROM p_tournament_id
         OR o.kind IS DISTINCT FROM a.obligation_kind
         OR o.place IS DISTINCT FROM a.place
         OR o.user_id IS DISTINCT FROM a.user_id
         OR o.amount_owed IS DISTINCT FROM a.amount
         OR o.amount_paid IS DISTINCT FROM a.amount
         OR o.settled_at IS NULL
         OR k.key IS NULL
         OR k.user_id IS DISTINCT FROM a.user_id
         OR k.amount IS DISTINCT FROM a.amount)
  ) THEN
    RAISE EXCEPTION 'satellite % cash ticket has no exact wallet/debt evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A cap-blocked full award remains the source pool's money but is held in a
  -- noncash, target-scoped ticket escrow. Prove the immutable award identity,
  -- exact issue journal and absence of a wallet credit on every replay.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_payouts p ON p.id=a.payout_id
      LEFT JOIN public.tournament_tickets tk ON tk.id=a.ticket_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key=a.idempotency_key||':ticket_escrow'
       AND l.to_type='escrow' AND l.to_entity_id=a.ticket_id
     WHERE a.tournament_id=p_tournament_id
       AND a.delivery_kind='ticket'
       AND (tk.id IS NULL
         OR tk.issued_by IS DISTINCT FROM
              '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid
         OR tk.holder_id IS DISTINCT FROM a.user_id
         OR tk.value IS DISTINCT FROM a.amount
         OR tk.status NOT IN ('issued','redeemed')
         OR tk.redemption_mode IS DISTINCT FROM 'tournament_entry_only'
         OR tk.source_tournament_id IS DISTINCT FROM v_h.target_id
         OR tk.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR tk.source_refund_entitlement_id IS NOT NULL
         OR tk.source_satellite_award_place IS DISTINCT FROM a.place
         OR tk.entry_prize IS DISTINCT FROM v_h.target_buy_in
         OR tk.entry_bounty IS DISTINCT FROM 0::numeric
         OR tk.entry_fee IS DISTINCT FROM v_h.target_fee
         OR p.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR p.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR p.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR p.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR l.id IS NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'escrow'
         OR l.to_entity_id IS DISTINCT FROM tk.id
         OR l.amount IS DISTINCT FROM a.amount
         OR l.category IS DISTINCT FROM 'ticket_issue'
         OR l.club_id IS DISTINCT FROM tk.club_id
         OR l.tournament_id IS DISTINCT FROM p_tournament_id
         OR l.settlement_id IS DISTINCT FROM
              'satellite-ticket:'||tk.id::text
         OR l.actor_service IS DISTINCT FROM 'fn_settle_satellite_tournament'
         OR l.pre_from_balance IS DISTINCT FROM
              round(v_h.pool-(a.place-1)*v_h.ticket_cost,2)
         OR l.post_from_balance IS DISTINCT FROM
              round(v_h.pool-a.place*v_h.ticket_cost,2)
         OR l.pre_to_balance IS DISTINCT FROM 0::numeric
         OR l.post_to_balance IS DISTINCT FROM a.amount
         OR l.metadata->>'kind' IS DISTINCT FROM
              'direct_satellite_entry_ticket'
         OR l.metadata->>'delivery_kind' IS DISTINCT FROM 'ticket'
         OR l.metadata->>'ticket_id' IS DISTINCT FROM tk.id::text
         OR l.metadata->>'payout_id' IS DISTINCT FROM a.payout_id::text
         OR l.metadata->>'satellite_id' IS DISTINCT FROM p_tournament_id::text
         OR l.metadata->>'satellite_target_id' IS DISTINCT FROM v_h.target_id::text
         OR l.metadata->>'user_id' IS DISTINCT FROM a.user_id::text
         OR l.metadata->>'position' IS DISTINCT FROM a.place::text
         OR (l.metadata->>'entry_prize')::numeric IS DISTINCT FROM
              v_h.target_buy_in
         OR (l.metadata->>'entry_bounty')::numeric IS DISTINCT FROM 0::numeric
         OR (l.metadata->>'entry_fee')::numeric IS DISTINCT FROM v_h.target_fee
         OR l.metadata->>'wallet_chips_credited' IS DISTINCT FROM '0'
         OR EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency wallet_key
            WHERE wallet_key.key=a.idempotency_key)
         OR (SELECT count(*)
               FROM public.chip_transactions issue_tx
              WHERE issue_tx.transaction_type='tournament_ticket_issue'
                AND issue_tx.club_id=tk.club_id
                AND issue_tx.from_user_id IS NULL
                AND issue_tx.to_user_id=a.user_id
                AND issue_tx.amount=a.amount
                AND issue_tx.metadata->>'ticket_id'=tk.id::text
                AND issue_tx.metadata->>'escrow_entity_id'=tk.id::text
                AND issue_tx.metadata->>'holder_id'=a.user_id::text
                AND (issue_tx.metadata->>'value')::numeric=a.amount
                AND issue_tx.metadata->>'redemption_mode'=
                      'tournament_entry_only'
                AND issue_tx.metadata->>'source_tournament_id'=
                      v_h.target_id::text
                AND issue_tx.metadata->>'source_satellite_id'=
                      p_tournament_id::text
                AND issue_tx.metadata->>'source_award_place'=a.place::text
                AND issue_tx.metadata->>'payout_id'=a.payout_id::text
                AND issue_tx.metadata->>'ledger_id'=l.id::text
                AND issue_tx.metadata->>'idempotency_key'=a.idempotency_key
                AND issue_tx.metadata->>'wallet_chips_credited'='0') <> 1)
  ) OR (SELECT count(*) FROM public.tournament_tickets tk
         WHERE tk.source_satellite_id=p_tournament_id
           AND tk.source_satellite_award_place IS NOT NULL)
       <> v_h.entry_ticket_count
    OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type='prize_liability'
           AND l.from_entity_id=p_tournament_id
           AND l.category='ticket_issue'
           AND l.metadata->>'kind'='direct_satellite_entry_ticket')
       <> v_h.entry_ticket_count THEN
    RAISE EXCEPTION
      'satellite % direct ticket has no exact noncash escrow evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.seat_count > 0 AND v_target.id IS NULL THEN
    RAISE EXCEPTION 'satellite % delivered seats into a missing target',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.tournament_satellite_awards a
      LEFT JOIN public.tournament_players target_player
        ON target_player.id = a.registration_id
      LEFT JOIN public.chip_ledger l
        ON l.idempotency_key = 'tourney:' || p_tournament_id::text
                               || ':seat:' || a.user_id::text || ':pool_transfer'
     WHERE a.tournament_id = p_tournament_id
       AND a.delivery_kind = 'seat'
       AND (target_player.id IS NULL
         OR target_player.tournament_id IS DISTINCT FROM v_h.target_id
           OR target_player.user_id IS DISTINCT FROM a.user_id
           OR COALESCE(target_player.is_satellite_qualifier, false) IS NOT TRUE
           OR target_player.source_satellite_id IS DISTINCT FROM p_tournament_id
         OR l.id IS NULL
         OR l.amount IS DISTINCT FROM v_h.ticket_cost
         OR l.from_type IS DISTINCT FROM 'prize_liability'
         OR l.from_entity_id IS DISTINCT FROM p_tournament_id
         OR l.to_type IS DISTINCT FROM 'prize_liability'
         OR l.to_entity_id IS DISTINCT FROM v_h.target_id
         OR l.category IS DISTINCT FROM 'tournament_buyin'
         OR l.metadata->>'registration_id' IS DISTINCT FROM a.registration_id::text)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = v_h.target_id
       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
  ) OR (SELECT count(*) FROM public.chip_ledger l
         WHERE l.from_type = 'prize_liability'
           AND l.from_entity_id = p_tournament_id
           AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                          || ':seat:%:pool_transfer')
       <> v_h.seat_count THEN
    RAISE EXCEPTION 'satellite % has malformed or extra actual-seat evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), round(COALESCE(sum(r.rake_amount), 0), 2)
    INTO v_rows, v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = v_h.target_id
     AND r.is_tournament
     AND r.source = 'fn_award_satellite_seat'
     AND r.metadata->>'satellite_id' = p_tournament_id::text;
  IF v_rows <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR v_rake IS DISTINCT FROM round(v_h.seat_count * v_h.target_fee, 2)
     OR (SELECT count(DISTINCT r.metadata->>'registration_id')
           FROM public.rake_records r
          WHERE r.tournament_id = v_h.target_id
            AND r.is_tournament
            AND r.source = 'fn_award_satellite_seat'
            AND r.metadata->>'satellite_id' = p_tournament_id::text)
          <> (CASE WHEN v_h.target_fee > 0 THEN v_h.seat_count ELSE 0 END)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_h.target_id
          AND r.is_tournament
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text
          AND (r.rake_amount IS DISTINCT FROM v_h.target_fee
            OR r.pot_size IS DISTINCT FROM v_h.ticket_cost
            OR r.metadata->>'kind' IS DISTINCT FROM 'satellite_seat_entry_fee'
            OR NOT EXISTS (
              SELECT 1 FROM public.tournament_satellite_awards a
               WHERE a.tournament_id = p_tournament_id
                 AND a.delivery_kind = 'seat'
                 AND a.user_id::text = r.metadata->>'user_id'
                 AND a.registration_id::text = r.metadata->>'registration_id'))
     ) OR EXISTS (
       SELECT 1
         FROM public.tournament_satellite_awards a
        WHERE a.tournament_id = p_tournament_id
          AND a.delivery_kind = 'seat'
          AND v_h.target_fee > 0
          AND (SELECT count(*)
                 FROM public.rake_records r
                WHERE r.tournament_id = v_h.target_id
                  AND r.is_tournament
                  AND r.source = 'fn_award_satellite_seat'
                  AND r.metadata->>'kind' = 'satellite_seat_entry_fee'
                  AND r.metadata->>'satellite_id' = p_tournament_id::text
                  AND r.metadata->>'user_id' = a.user_id::text
                  AND r.metadata->>'registration_id' = a.registration_id::text
                  AND r.rake_amount = v_h.target_fee
                  AND r.pot_size = v_h.ticket_cost) <> 1
     ) THEN
    RAISE EXCEPTION 'satellite % has malformed target-entry evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;
  IF v_rows <> (v_h.cash_ticket_count
                + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'satellite % has missing or extra obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_h.remainder > 0 THEN
    IF (SELECT count(*) FROM public.tournament_satellite_remainders r
         WHERE r.tournament_id = p_tournament_id) <> 1
       OR NOT EXISTS (
      SELECT 1
        FROM public.tournament_players bubble
        JOIN public.tournament_satellite_remainders r
          ON r.tournament_id = p_tournament_id
         AND r.user_id = bubble.user_id
         AND r.place = v_h.bubble_position
         AND r.amount = v_h.remainder
        JOIN public.tournament_payouts p
          ON p.id = r.payout_id
         AND p.tournament_id = p_tournament_id
         AND p.user_id = bubble.user_id
         AND p."position" IS NOT DISTINCT FROM r.payout_position
         AND p.amount = v_h.remainder
         AND p.source = r.payout_source
         AND p.idempotency_key = r.idempotency_key
        JOIN public.tournament_obligations o
          ON o.id = r.obligation_id
         AND o.tournament_id = p_tournament_id
         AND o.kind = r.obligation_kind
         AND o.place IS NOT DISTINCT FROM r.obligation_place
         AND o.user_id = bubble.user_id
         AND o.amount_owed = v_h.remainder
         AND o.amount_paid = v_h.remainder
         AND o.settled_at IS NOT NULL
        JOIN public.wallet_credit_idempotency k
          ON k.key = r.idempotency_key
         AND k.user_id = bubble.user_id
         AND k.amount = v_h.remainder
       WHERE bubble.tournament_id = p_tournament_id
         AND bubble.user_id = v_h.bubble_user_id
         AND bubble.position = v_h.bubble_position
         AND (
           (r.evidence_kind = 'atomic'
             AND r.payout_position IS NOT DISTINCT FROM r.place
             AND r.obligation_place IS NOT DISTINCT FROM r.place
             AND r.idempotency_key = 'tourney:' || p_tournament_id::text
                 || ':satellite_remainder:place:' || r.place::text)
           OR r.evidence_kind = 'legacy_20260908_682')
    ) THEN
      RAISE EXCEPTION 'satellite % has no exact single-bubble remainder payment',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_remainder := jsonb_build_object(
      'user_id', v_h.bubble_user_id,
      'position', v_h.bubble_position,
      'amount', v_h.remainder);
  ELSIF EXISTS (SELECT 1 FROM public.tournament_satellite_remainders r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'satellite_remainder'
     ) THEN
    RAISE EXCEPTION 'satellite % has remainder evidence when remainder is zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_expected_rows := v_h.ticket_award_count
                     + CASE WHEN v_h.remainder > 0 THEN 1 ELSE 0 END;
  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_rows, v_amount
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_rows <> v_expected_rows OR v_amount IS DISTINCT FROM v_h.pool THEN
    RAISE EXCEPTION
      'satellite % payout evidence has % rows / % chips, expected % / %',
      p_tournament_id, v_rows, v_amount, v_expected_rows, v_h.pool
      USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.prize IS DISTINCT FROM CASE
         WHEN public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) BETWEEN 1 AND v_h.ticket_award_count THEN v_h.ticket_cost
         WHEN v_h.remainder > 0 AND tp.position = v_h.bubble_position
           THEN v_h.remainder
         ELSE 0::numeric
       END
  ) THEN
    RAISE EXCEPTION 'satellite % prize cache disagrees with its receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.prize_out IS DISTINCT FROM v_h.pool
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.closed_at IS DISTINCT FROM v_h.source_escrow_closed_at
     OR v_source_escrow.close_note IS DISTINCT FROM v_h.source_escrow_close_note
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION 'satellite % did not close every escrow bank at zero',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_rake_settlement
    FROM public.tournament_rake_settlements s
   WHERE s.tournament_id = p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_rake
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;
  IF v_rake_settlement.tournament_id IS NULL
     OR v_rake_settlement.settled_at IS NULL
     OR v_rake_settlement.amount IS DISTINCT FROM v_rake
     OR (v_rake > 0 AND v_rake_settlement.attributed_at IS NULL) THEN
    RAISE EXCEPTION 'satellite % rake has no exact terminal settlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'delivery_kind', a.delivery_kind,
           'payout_id', a.payout_id,
           'registration_id', a.registration_id,
           'ticket_id', a.ticket_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_awards
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.user_id,
           'position', a.place,
           'amount', a.amount,
           'registration_id', a.registration_id)
         ORDER BY a.place), '[]'::jsonb)
    INTO v_seats
    FROM public.tournament_satellite_awards a
   WHERE a.tournament_id = p_tournament_id
     AND a.delivery_kind = 'seat';

  v_winner_amount := CASE WHEN v_h.ticket_award_count > 0
                          THEN v_h.ticket_cost ELSE v_h.remainder END;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', 'COMPLETED',
    'tournament_id', p_tournament_id,
    'target_id', v_h.target_id,
    'winner_id', v_h.winner_id,
    'field_size', v_h.field_size,
    'pool', v_h.pool,
    'ticket_cost', v_h.ticket_cost,
    'ticket_award_count', v_h.ticket_award_count,
    'seat_count', v_h.seat_count,
    'cash_ticket_count', v_h.cash_ticket_count,
    'entry_ticket_count', v_h.entry_ticket_count,
    'awards', v_awards,
    'seats', v_seats,
    'remainder', v_remainder,
    'winner_amount', CASE WHEN v_h.completion_kind='equal_qualifiers' THEN NULL ELSE v_winner_amount END,
    'completion_kind', v_h.completion_kind,
    'qualifiers', CASE WHEN v_h.completion_kind='equal_qualifiers' THEN
      (SELECT jsonb_agg(jsonb_build_object(
        'user_id',q.user_id,'registration_id',q.registration_id,
        'award_ordinal',q.award_ordinal,'qualified_chips',q.qualified_chips,
        'qualified_at',q.qualified_at) ORDER BY q.award_ordinal)
       FROM public.tournament_satellite_qualifiers q WHERE q.tournament_id=p_tournament_id)
      ELSE NULL END,
    'source_table_count', v_h.source_table_count,
    'source_seat_count', v_h.source_seat_count,
    'released_seat_count', v_h.released_seat_count,
    'source_closeout', jsonb_build_object(
      'source_table_count', v_h.source_table_count,
      'source_table_ids', to_jsonb(v_h.source_table_ids),
      'source_seat_count', v_h.source_seat_count,
      'source_seat_ids', to_jsonb(v_h.source_seat_ids),
      'released_seat_count', v_h.released_seat_count,
      'released_seat_ids', to_jsonb(v_h.released_seat_ids),
      'closed_at', v_h.source_closed_at,
      'escrow_closed_at', v_h.source_escrow_closed_at,
      'escrow_close_note', v_h.source_escrow_close_note),
    'settled_at', v_h.settled_at,
    'receipt_version', v_h.receipt_version);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_qualified_user_ids uuid[], p_prepare_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_qualification boolean := p_qualified_user_ids IS NOT NULL;
  v_entitlement jsonb;
  v_boundary public.tournament_satellite_qualification_boundaries%ROWTYPE;
  v_stacks jsonb;
  v_qualifiers uuid[];
  v_expected_qualifiers uuid[];
  v_source record;
  v_target record;
  v_target_after record;
  v_winner public.tournament_players%ROWTYPE;
  v_finisher public.tournament_players%ROWTYPE;
  v_existing_target public.tournament_players%ROWTYPE;
  v_source_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow public.tournament_escrow%ROWTYPE;
  v_target_escrow_after public.tournament_escrow%ROWTYPE;
  v_existing_header public.tournament_satellite_settlements%ROWTYPE;
  v_obligation public.tournament_obligations%ROWTYPE;
  v_observed_target_id uuid;
  v_target_id uuid;
  v_target_open boolean := false;
  v_pool numeric;
  v_target_buy_in numeric;
  v_target_fee numeric;
  v_ticket_cost numeric;
  v_advertised_seats integer;
  v_ticket_award_count integer;
  v_seat_count integer := 0;
  v_cash_ticket_count integer := 0;
  v_entry_ticket_count integer := 0;
  v_remainder numeric;
  v_bubble_position integer;
  v_bubble_user_id uuid;
  v_field_size integer;
  v_target_count integer := 0;
  v_target_count_before integer := 0;
  v_target_live_count integer := 0;
  v_target_live_count_before integer := 0;
  v_target_counter_before integer := 0;
  v_target_counter_after integer := 0;
  v_target_slots integer := 0;
  v_live_count integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_place integer;
  v_cap_user_id uuid;
  v_cap_load integer;
  v_rows integer;
  v_registration_id uuid;
  v_ticket_id uuid;
  v_ticket_club_id uuid;
  v_ticket_ledger_id uuid;
  v_ticket_transaction_id uuid;
  v_payout_id uuid;
  v_pool_before numeric;
  v_rake_result jsonb;
  v_credited boolean;
  v_payout_count integer;
  v_paid numeric;
  v_delivery_kind text;
  v_payout_key text;
  v_plan jsonb := '[]'::jsonb;
  v_plan_item jsonb;
  v_source_table_ids uuid[] := ARRAY[]::uuid[];
  v_source_seat_ids uuid[] := ARRAY[]::uuid[];
  v_released_seat_ids uuid[] := ARRAY[]::uuid[];
  v_source_table_count integer := 0;
  v_source_seat_count integer := 0;
  v_released_seat_count integer := 0;
  v_closeout_at timestamptz := transaction_timestamp();
  v_source_escrow_close_note text :=
    'atomic satellite terminal receipt: exact zero';
BEGIN
  -- Every terminal money authority takes this transaction lock before any
  -- row lock. Cash and satellite finishes can pay the same wallets, so one
  -- shared first lock prevents opposite recipient orders from deadlocking.
  PERFORM public.fn_ca_lock_settlement_lane_global();

  IF p_tournament_id IS NULL OR (NOT v_qualification AND p_observed_winner_id IS NULL)
     OR (v_qualification AND p_observed_winner_id IS NOT NULL) THEN
    RAISE EXCEPTION 'satellite settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  IF v_qualification THEN
    SELECT array_agg(id ORDER BY id) INTO v_expected_qualifiers
      FROM unnest(p_qualified_user_ids) AS requested(id);
    IF cardinality(v_expected_qualifiers) < 2
       OR cardinality(v_expected_qualifiers) IS NULL
       OR array_position(v_expected_qualifiers,NULL) IS NOT NULL
       OR (SELECT count(DISTINCT id) FROM unnest(p_qualified_user_ids) requested(id))
            <> cardinality(p_qualified_user_ids) THEN
      RAISE EXCEPTION 'qualification requires distinct nonnull participant ids'
        USING ERRCODE='22023';
    END IF;
  END IF;

  -- A committed header wins before target admission is inspected. Replays can
  -- never turn a previously delivered seat into cash because a target closed.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_qualification AND (
       v_existing_header.completion_kind <> 'equal_qualifiers'
       OR (SELECT array_agg(q.user_id ORDER BY q.user_id)
             FROM public.tournament_satellite_qualifiers q
            WHERE q.tournament_id=p_tournament_id)
            IS DISTINCT FROM v_expected_qualifiers) THEN
      RAISE EXCEPTION 'stored satellite qualifiers differ from the observed cohort'
        USING ERRCODE='40001';
    END IF;
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  SELECT COALESCE(t.satellite_target_id, t.satellite_target)
    INTO v_observed_target_id
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_observed_target_id IS NULL OR v_observed_target_id = p_tournament_id THEN
    RAISE EXCEPTION 'satellite % has no distinct target', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- During the rolling cutover the legacy seat door still takes target before
  -- source. Match that order until stage two removes it; the global lock also
  -- serializes this authority with every new terminal payer.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (p_tournament_id, v_observed_target_id)
   ORDER BY CASE WHEN t.id = v_observed_target_id THEN 0 ELSE 1 END, t.id
   FOR UPDATE;
  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.satellite_seats,
         t.prize_pool, t.prize_pool_finalized, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin
    INTO v_source FROM public.tournaments t
   WHERE t.id = p_tournament_id;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'tournament % disappeared while being locked', p_tournament_id
      USING ERRCODE = '40001';
  END IF;
  IF v_source.satellite_target_id IS NOT NULL
     AND v_source.satellite_target IS NOT NULL
     AND v_source.satellite_target_id IS DISTINCT FROM v_source.satellite_target THEN
    RAISE EXCEPTION 'satellite % has conflicting target columns',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_target_id := COALESCE(v_source.satellite_target_id, v_source.satellite_target);
  IF v_target_id IS DISTINCT FROM v_observed_target_id THEN
    RAISE EXCEPTION 'satellite % target changed while settlement acquired locks',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- A concurrent caller may have committed while this caller waited above.
  SELECT * INTO v_existing_header
    FROM public.tournament_satellite_settlements s
   WHERE s.tournament_id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_qualification AND (
       v_existing_header.completion_kind <> 'equal_qualifiers'
       OR (SELECT array_agg(q.user_id ORDER BY q.user_id)
             FROM public.tournament_satellite_qualifiers q
            WHERE q.tournament_id=p_tournament_id)
            IS DISTINCT FROM v_expected_qualifiers) THEN
      RAISE EXCEPTION 'stored satellite qualifiers differ from the observed cohort'
        USING ERRCODE='40001';
    END IF;
    RETURN public.fn_ca_satellite_settlement_receipt(
      p_tournament_id, p_observed_winner_id);
  END IF;

  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'
     AND upper(COALESCE(v_source.tournament_type, '')) <> 'SATELLITE'
     AND v_source.satellite_target_id IS NULL
     AND v_source.satellite_target IS NULL THEN
    RAISE EXCEPTION 'tournament % is not a satellite', p_tournament_id
      USING ERRCODE = '22023';
  END IF;
  IF upper(COALESCE(v_source.status, '')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'satellite % cannot first-settle from status %',
      p_tournament_id, v_source.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'satellite % prize pool is not finalized; guarantee funding is not proven',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_source.is_bounty, false)
     OR COALESCE(v_source.is_pko, false)
     OR COALESCE(v_source.is_mystery_bounty, false)
     OR COALESCE(v_source.is_premium_spin, false)
     OR lower(COALESCE(v_source.variant, '')) = 'spin'
     OR upper(COALESCE(v_source.tournament_type, '')) = 'SPIN' THEN
    RAISE EXCEPTION 'satellite % mixes another payout authority', p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  v_pool := v_source.prize_pool;
  v_advertised_seats := COALESCE(v_source.satellite_seats, 0);
  IF v_pool IS NULL OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0 OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'satellite % has invalid whole-cent pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  IF v_advertised_seats < 0 THEN
    RAISE EXCEPTION 'satellite % has invalid advertised seat count %',
      p_tournament_id, v_advertised_seats USING ERRCODE = '22003';
  END IF;

  SELECT t.id, t.name, t.club_id, t.status, t.variant, t.tournament_type,
         t.buy_in_amount, t.buy_in_fee, t.is_bounty, t.is_pko,
         t.is_mystery_bounty, t.is_premium_spin,
         t.max_players, t.current_players, t.current_level,
         t.late_reg_levels, t.rebuy_levels, t.prize_pool_finalized,
         t.prize_pool, t.total_rake
    INTO v_target FROM public.tournaments t
   WHERE t.id = v_target_id
   FOR UPDATE;
  IF v_target.id IS NULL THEN
    -- PostgreSQL cannot row-lock an absent target. Refuse the settlement so a
    -- concurrent same-id target insert can never race a cash substitution.
    RAISE EXCEPTION
      'satellite % target % is missing; absence cannot authorize cash substitution',
      p_tournament_id, v_target_id USING ERRCODE = 'P0404';
  END IF;
  v_target_buy_in := v_target.buy_in_amount;
  v_target_fee := COALESCE(v_target.buy_in_fee, 0);
  IF v_target_buy_in IS NULL
     OR v_target_buy_in::text IN ('NaN','Infinity','-Infinity')
     OR v_target_buy_in < 0
     OR v_target_buy_in IS DISTINCT FROM round(v_target_buy_in, 2)
     OR v_target_fee IS NULL
     OR v_target_fee::text IN ('NaN','Infinity','-Infinity')
     OR v_target_fee < 0
     OR v_target_fee IS DISTINCT FROM round(v_target_fee, 2) THEN
    RAISE EXCEPTION 'satellite % target has an invalid whole-cent entry contract',
      p_tournament_id USING ERRCODE = '22003';
  END IF;
  v_ticket_cost := round(v_target_buy_in + v_target_fee, 2);
  IF v_ticket_cost <= 0 THEN
    RAISE EXCEPTION 'satellite % target ticket has no positive value',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  -- A bounty or Spin target needs a different, fully receipted split across
  -- prize, fee and bounty rails. This authority deliberately refuses that
  -- contract instead of silently classifying the bounty slice as prize.
  IF (
       v_target.is_bounty IS DISTINCT FROM false
       OR v_target.is_pko IS DISTINCT FROM false
       OR v_target.is_mystery_bounty IS DISTINCT FROM false
       OR v_target.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(v_target.variant,'')) = 'spin'
       OR upper(COALESCE(v_target.tournament_type,'')) = 'SPIN'
     ) THEN
    RAISE EXCEPTION
      'satellite % target % uses an unsupported bounty or Spin entry split',
      p_tournament_id, v_target_id USING ERRCODE = '22023';
  END IF;
  IF v_pool < v_advertised_seats * v_ticket_cost THEN
    RAISE EXCEPTION
      'satellite % finalized pool % does not fund its % advertised tickets at % each',
      p_tournament_id, v_pool, v_advertised_seats, v_ticket_cost
      USING ERRCODE = 'P0403';
  END IF;

  -- Open and own only the source escrow before the delivery plan is known. A
  -- cash-only plan must not touch a completed target's immutable escrow merely
  -- to prove that no seat will be delivered there.
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id, 'atomic satellite settlement source lock');
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id;
  IF v_source_escrow.tournament_id IS NULL
     OR COALESCE(v_source_escrow.enforced, false) IS NOT TRUE
     OR v_source_escrow.closed_at IS NOT NULL
     OR v_source_escrow.close_note IS NOT NULL
     OR v_source_escrow.prize_balance IS DISTINCT FROM v_pool
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.refund_bounty IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_out IS DISTINCT FROM 0::numeric
     OR v_source_escrow.reserve_in IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS NULL
     OR v_source_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v_source_escrow.fee_balance < 0
     OR v_source_escrow.fee_balance IS DISTINCT FROM round(v_source_escrow.fee_balance, 2)
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY[
           'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
           'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
           'refund_prize','refund_bounty','refund_fee',
           'prize_balance','bounty_balance','fee_balance',
           'reserve_out','reserve_in'
         ]::text[]) AS component(name)
         CROSS JOIN LATERAL (
           SELECT (to_jsonb(v_source_escrow)->>component.name)::numeric AS amount
         ) AS persisted
        WHERE persisted.amount IS NULL
           OR CASE
                WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                  THEN true
                ELSE persisted.amount < 0
                  OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
              END
     ) THEN
    RAISE EXCEPTION
      'satellite % escrow does not hold exactly its locked pool (pool %, prize %, bounty %, fee %)',
      p_tournament_id, v_pool, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id IN (p_tournament_id, v_target_id)
   ORDER BY tp.tournament_id, tp.id FOR UPDATE;

  -- Keep the same root lock order used by every terminal authority: tournament,
  -- tournament roster, source tables, then source seats. The identities are
  -- frozen before any payer runs and become part of the immutable header.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
  SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[])
    INTO v_source_table_ids
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id;
  SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id)
                    FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
    INTO v_source_seat_ids, v_released_seat_ids
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = p_tournament_id;
  v_source_table_count := cardinality(v_source_table_ids);
  v_source_seat_count := cardinality(v_source_seat_ids);
  v_released_seat_count := cardinality(v_released_seat_ids);
  IF v_source_table_count < 1 THEN
    RAISE EXCEPTION 'satellite % has no source table to close', p_tournament_id
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_field_size FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  SELECT count(*),
         count(*) FILTER (
           WHERE tp.status::text IN ('registered','playing'))
    INTO v_target_count, v_target_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = v_target_id;
  v_target_count_before := v_target_count;
  v_target_live_count_before := v_target_live_count;
  -- Before start, current_players is the live lobby count maintained by the
  -- canonical roster trigger. Once RUNNING, it is the immutable total entrant
  -- count and must not shrink when a player is eliminated.
  v_target_counter_before := CASE
    WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
      THEN v_target_live_count_before
    ELSE v_target_count_before
  END;
  IF v_field_size < 1 THEN
    RAISE EXCEPTION 'satellite % has no final field', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (tp.status IS NULL
         OR tp.status::text NOT IN ('playing','winner','eliminated'))
  ) THEN
    RAISE EXCEPTION 'satellite % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Apart from the one explicitly adopted historical miss below, a new
  -- settlement must start with no money, target-seat or cache fragments.
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r
                 WHERE r.tournament_id = p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = p_tournament_id
                   AND COALESCE(tp.prize, 0) <> 0)
     OR EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id = p_tournament_id
          AND l.idempotency_key LIKE 'tourney:' || p_tournament_id::text
                                       || ':seat:%:pool_transfer')
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = v_target_id
          AND tp.source_satellite_id = p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id = v_target_id
          AND r.source = 'fn_award_satellite_seat'
          AND r.metadata->>'satellite_id' = p_tournament_id::text) THEN
    RAISE EXCEPTION 'satellite % has partial or legacy settlement evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_qualification THEN
    v_entitlement:=public.fn_materialize_satellite_entitlements_locked(p_tournament_id);
    IF v_entitlement->>'ok' IS DISTINCT FROM 'true'
       OR v_entitlement->>'ready' IS DISTINCT FROM 'true'
       OR v_entitlement->>'is_satellite' IS DISTINCT FROM 'true'
       OR (v_entitlement->>'source_pool')::numeric IS DISTINCT FROM v_pool
       OR (v_entitlement->>'ticket_value')::numeric IS DISTINCT FROM v_ticket_cost
       OR (v_entitlement->>'target_tournament_id')::uuid IS DISTINCT FROM v_target_id
       OR (v_entitlement->>'award_depth')::integer IS DISTINCT FROM cardinality(v_expected_qualifiers) THEN
      RAISE EXCEPTION 'equal qualification disagrees with the frozen funded entitlement plan'
        USING ERRCODE='P0404';
    END IF;
    -- This version supports only a complete equal-value seat cohort. A hand
    -- crossing below K, or a residual cash place, requires a separate tie
    -- contract and cannot borrow a winner or a finishing ordinal here.
    IF v_pool <> cardinality(v_expected_qualifiers)*v_ticket_cost THEN
      RAISE EXCEPTION 'qualification requires exactly K fully funded equal awards with zero remainder'
        USING ERRCODE='55000';
    END IF;
    SELECT array_agg(tp.user_id ORDER BY tp.user_id) INTO v_qualifiers
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.status::text='playing';
    IF v_qualifiers IS DISTINCT FROM v_expected_qualifiers OR EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND (
         (tp.user_id=ANY(v_expected_qualifiers) AND
           (tp.status::text<>'playing' OR tp.position IS NOT NULL
            OR tp.chips IS NULL OR tp.chips::text IN ('NaN','Infinity','-Infinity')
            OR tp.chips<=0 OR tp.eliminated_at IS NOT NULL
            OR tp.elimination_sequence IS NOT NULL))
         OR (NOT tp.user_id=ANY(v_expected_qualifiers) AND tp.status::text<>'eliminated'))
    ) THEN
      RAISE EXCEPTION 'qualification cohort differs from the settled live roster'
        USING ERRCODE='40001';
    END IF;
    -- The manager parks every source engine before observing this cohort.
    -- Its physical boundary and this locked reciprocal roster/seat witness
    -- must agree before any source chips, awards or fees can move.
    IF cardinality(v_released_seat_ids)<>cardinality(v_expected_qualifiers)
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id
            AND tp.user_id=ANY(v_expected_qualifiers)
            AND (SELECT count(*) FROM public.table_seats seat
                   JOIN public.tables tb ON tb.id=seat.table_id
                  WHERE tb.tournament_id=p_tournament_id
                    AND seat.user_id=tp.user_id AND seat.left_at IS NULL
                    AND seat.table_id=tp.table_id AND seat.seat_number=tp.seat_number
                    AND seat.stack::numeric=tp.chips::numeric)<>1) THEN
      RAISE EXCEPTION 'qualification has no exact positive settled roster-seat cohort'
        USING ERRCODE='40001';
    END IF;
    SELECT jsonb_object_agg(tp.user_id::text,tp.chips) INTO v_stacks
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=ANY(v_expected_qualifiers);
    SELECT * INTO v_boundary FROM public.tournament_satellite_qualification_boundaries b
     WHERE b.tournament_id=p_tournament_id FOR UPDATE;
    IF FOUND AND (
       v_boundary.qualified_user_ids IS DISTINCT FROM v_expected_qualifiers
       OR v_boundary.qualified_stacks IS DISTINCT FROM v_stacks
       OR v_boundary.source_table_ids IS DISTINCT FROM v_source_table_ids
       OR v_boundary.source_seat_ids IS DISTINCT FROM v_released_seat_ids) THEN
      RAISE EXCEPTION 'stored qualification boundary differs from the locked settled cohort'
        USING ERRCODE='40001';
    END IF;
    IF p_prepare_only THEN
      -- Target, roster and seat locks may wait after the outer lease check.
      -- Recheck at the durable write boundary while the lease row is held.
      IF NOT EXISTS (
        SELECT 1 FROM public.engine_tournament_leases l
         WHERE l.tournament_id=p_tournament_id AND l.protocol_version=2
           AND current_setting('app.atomic_satellite_qualification',true)
                 =p_tournament_id::text||':'||l.lease_generation::text
           AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds'
      ) THEN
        RAISE EXCEPTION 'satellite qualification lease expired while acquiring its settled cohort'
          USING ERRCODE='40001';
      END IF;
      IF v_boundary.tournament_id IS NULL THEN
        INSERT INTO public.tournament_satellite_qualification_boundaries
          (tournament_id,qualified_user_ids,lease_generation,qualified_stacks,source_table_ids,
           source_seat_ids,qualified_at)
        VALUES(p_tournament_id,v_expected_qualifiers,
               (SELECT l.lease_generation FROM public.engine_tournament_leases l
                 WHERE l.tournament_id=p_tournament_id
                   AND current_setting('app.atomic_satellite_qualification',true)
                     =p_tournament_id::text||':'||l.lease_generation::text),
               v_stacks,v_source_table_ids,
               v_released_seat_ids,v_closeout_at)
        RETURNING * INTO v_boundary;
      END IF;
      UPDATE public.tournaments SET status='COMPLETING',updated_at=now()
       WHERE id=p_tournament_id AND upper(status::text) IN ('RUNNING','COMPLETING');
      RETURN jsonb_build_object('ok',true,'qualification_prepared',true,
        'tournament_id',p_tournament_id,'completion_kind','equal_qualifiers',
        'qualified_user_ids',to_jsonb(v_boundary.qualified_user_ids),
        'qualified_at',v_boundary.qualified_at,'lease_generation',v_boundary.lease_generation);
    END IF;
    IF v_boundary.tournament_id IS NULL OR upper(v_source.status::text)<>'COMPLETING' THEN
      RAISE EXCEPTION 'equal qualification requires the durable settled-hand admission first'
        USING ERRCODE='55000';
    END IF;
    INSERT INTO public.tournament_satellite_qualifiers
      (tournament_id,user_id,registration_id,award_ordinal,qualified_chips,qualified_at)
    SELECT p_tournament_id,tp.user_id,tp.id,
           row_number() OVER (ORDER BY tp.user_id)::integer,tp.chips,v_boundary.qualified_at
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=ANY(v_expected_qualifiers);
    UPDATE public.tournament_players tp
       SET status='winner',position=NULL,eliminated_at=NULL,elimination_sequence=NULL
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=ANY(v_expected_qualifiers);
  ELSE
  SELECT count(*) INTO v_live_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'satellite % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    SELECT * INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'satellite % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
           OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL
     OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION
      'observed winner % does not match the locked last survivor in satellite %',
      p_observed_winner_id, p_tournament_id USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = 1 AND tp.user_id IS DISTINCT FROM v_winner.user_id
  ) THEN
    RAISE EXCEPTION 'satellite % assigns first place to another player',
      p_tournament_id USING ERRCODE = '23505';
  END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1,
         eliminated_at = NULL, elimination_sequence = NULL
   WHERE id = v_winner.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not promote exactly one winner',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_eliminated_count <> v_field_size - 1
     OR v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION
      'satellite % has no complete durable elimination sequence (%/% of %)',
      p_tournament_id, v_sequenced_count, v_distinct_sequence_count,
      v_eliminated_count USING ERRCODE = 'P0404';
  END IF;

  -- No evidence exists, so numeric positions can be rebuilt from the durable
  -- transition order without relabelling a payment.
  UPDATE public.tournament_players tp
     SET position = NULL
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  WITH ranked AS (
    SELECT tp.id,
           row_number() OVER (
             ORDER BY tp.elimination_sequence DESC, tp.id ASC
           )::integer + 1 AS final_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  UPDATE public.tournament_players tp
     SET position = ranked.final_position
    FROM ranked
   WHERE tp.id = ranked.id;

  SELECT count(*), count(DISTINCT tp.position)
    INTO v_rows, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position BETWEEN 1 AND v_field_size;
  IF v_rows <> v_field_size OR v_distinct_sequence_count <> v_field_size THEN
    RAISE EXCEPTION 'satellite % could not prove contiguous final standings',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  END IF;

  v_ticket_award_count := floor(v_pool / v_ticket_cost)::integer;
  v_remainder := round(v_pool - v_ticket_award_count * v_ticket_cost, 2);
  IF v_remainder < 0 OR v_remainder >= v_ticket_cost THEN
    RAISE EXCEPTION 'satellite % derived invalid residual % below ticket %',
      p_tournament_id, v_remainder, v_ticket_cost USING ERRCODE = '23514';
  END IF;
  IF (v_ticket_award_count
      + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END) > v_field_size THEN
    RAISE EXCEPTION
      'satellite % pool needs % ticket/remainder finishers but field has %',
      p_tournament_id,
      v_ticket_award_count + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END,
      v_field_size USING ERRCODE = '23514';
  END IF;
  IF v_remainder > 0 THEN
    v_bubble_position := v_ticket_award_count + 1;
    SELECT tp.user_id INTO v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_position;
    IF NOT FOUND OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'satellite % has no single bubble at place %',
        p_tournament_id, v_bubble_position USING ERRCODE = 'P0404';
    END IF;
  END IF;

  -- Decide a complete immutable delivery plan while target and roster locks are
  -- held. Only explicit terminal or full states become cash. Any other
  -- unknown lifecycle state refuses the whole settlement.
  IF COALESCE(v_target.max_players, 0) < 0
     OR v_target.late_reg_levels < 0
     OR v_target.rebuy_levels < 0 THEN
    RAISE EXCEPTION
      'satellite % target % has invalid admission bounds',
      p_tournament_id, v_target_id USING ERRCODE = '22003';
  END IF;
  IF v_target.max_players IS NOT NULL AND v_target.max_players > 0
     AND v_target_count >= v_target.max_players THEN
    v_target_open := false;
  ELSIF COALESCE(v_target.prize_pool_finalized, false) THEN
    v_target_open := false;
  ELSIF upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING') THEN
    v_target_open := true;
  ELSIF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN
    IF v_target.current_level < 0 THEN
      RAISE EXCEPTION
        'satellite % target % has invalid RUNNING admission level',
        p_tournament_id, v_target_id USING ERRCODE = '55000';
    END IF;
    -- The target row and both rosters are already locked. Delegate the actual
    -- RUNNING admission decision to the same canonical authority used by every
    -- other late-registration path, including its minutes-based fallback.
    v_target_open :=
      public.fn_tournament_late_registration_open(v_target_id);
  ELSIF upper(COALESCE(v_target.status, '')) IN
        ('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
    v_target_open := false;
  ELSE
    RAISE EXCEPTION
      'satellite % target % admission state % is ambiguous',
      p_tournament_id, v_target_id, v_target.status
      USING ERRCODE = '55000';
  END IF;
  IF v_target_open THEN
    v_target_slots := CASE
      WHEN v_target.max_players IS NULL OR v_target.max_players = 0
        THEN v_ticket_award_count
      ELSE GREATEST(v_target.max_players - v_target_count, 0)
    END;
  END IF;

  -- The booking and live-seat triggers serialize every four-table decision on
  -- this same user key. Take all winner keys in UUID order before classifying
  -- anyone, so a concurrent seat cannot race a direct-ticket disposition and
  -- two multi-award satellites cannot deadlock by taking the keys oppositely.
  FOR v_cap_user_id IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id
       AND public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id)
           BETWEEN 1 AND v_ticket_award_count
     ORDER BY tp.user_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('table_cap:'||v_cap_user_id::text,0));
  END LOOP;

  -- An equal-value cohort has no rank that could prioritize limited target
  -- places. Do not let its deterministic payment ordinal choose seat versus
  -- cash delivery when only part of the unregistered cohort fits.
  IF v_qualification AND v_target_open AND v_target_slots < (
    SELECT count(*) FROM public.tournament_satellite_qualifiers q
     WHERE q.tournament_id=p_tournament_id AND NOT EXISTS (
       SELECT 1 FROM public.tournament_players target_player
        WHERE target_player.tournament_id=v_target_id
          AND target_player.user_id=q.user_id)) THEN
    RAISE EXCEPTION 'partial target capacity needs an explicit equal-cohort delivery policy'
      USING ERRCODE='55000';
  END IF;

  IF v_ticket_award_count > 0 THEN
    FOR v_place IN 1..v_ticket_award_count LOOP
      SELECT * INTO v_finisher FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) = v_place;
      IF v_finisher.id IS NULL THEN
        RAISE EXCEPTION 'satellite % has no finisher at ticket place %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_delivery_kind := 'cash';
      SELECT * INTO v_existing_target FROM public.tournament_players tp
       WHERE tp.tournament_id = v_target_id
         AND tp.user_id = v_finisher.user_id;
      IF FOUND THEN
        IF COALESCE(v_existing_target.is_satellite_qualifier, false) IS NOT TRUE THEN
          v_delivery_kind := 'cash';
        ELSIF v_existing_target.source_satellite_id IS NULL THEN
          RAISE EXCEPTION
            'satellite % cannot prove origin of target seat held by place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSIF v_existing_target.source_satellite_id = p_tournament_id THEN
          RAISE EXCEPTION
            'satellite % has an unreceipted target seat already delivered to place %',
            p_tournament_id, v_place USING ERRCODE = 'P0404';
        ELSE
          v_delivery_kind := 'cash';
        END IF;
      ELSIF v_target_open AND v_seat_count < v_target_slots THEN
        v_cap_load:=public.fn_concurrent_game_load(
          v_finisher.user_id,NULL,NULL,v_target_id);
        IF v_cap_load>=4 THEN
          -- The cap remains absolute. The winner receives the funded entry as
          -- a noncash tournament ticket instead of a fifth game or wallet chips.
          v_delivery_kind := 'ticket';
        ELSE
          v_delivery_kind := 'seat';
        END IF;
      END IF;

      IF v_delivery_kind = 'seat' THEN
        v_seat_count := v_seat_count + 1;
      ELSIF v_delivery_kind = 'ticket' THEN
        v_entry_ticket_count := v_entry_ticket_count + 1;
      ELSE
        v_cash_ticket_count := v_cash_ticket_count + 1;
      END IF;
      v_plan := v_plan || jsonb_build_array(jsonb_build_object(
        'place', v_place,
        'user_id', v_finisher.user_id,
        'delivery_kind', v_delivery_kind));
    END LOOP;
  END IF;
  IF v_seat_count + v_cash_ticket_count + v_entry_ticket_count
       <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % did not classify every funded ticket',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  -- Closed/full/independently-held tickets are cash substitutions and do not
  -- touch target aggregates. Validate those mutable target banks only when
  -- this exact plan will add at least one real registration.
  IF v_seat_count > 0 THEN
    -- Zero-delta reconstruction is a write when the escrow already exists, so
    -- it belongs after seat classification and only on the actual seat path.
    PERFORM public.fn_ca_escrow_apply(
      v_target_id, 'atomic satellite settlement target seat lock');
    SELECT * INTO v_target_escrow FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
  END IF;
  IF v_seat_count > 0 AND (
       v_target.current_players IS NULL
       OR v_target.current_players < 0
       OR v_target.current_players IS DISTINCT FROM v_target_counter_before
       OR v_target.prize_pool IS NULL
       OR v_target.prize_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_target.prize_pool < 0
       OR v_target.prize_pool IS DISTINCT FROM round(v_target.prize_pool, 2)
       OR v_target.total_rake IS NULL
       OR v_target.total_rake::text IN ('NaN','Infinity','-Infinity')
       OR v_target.total_rake < 0
       OR v_target.total_rake IS DISTINCT FROM round(v_target.total_rake, 2)
       OR (v_target_fee > 0 AND v_target.club_id IS NULL)
       OR v_target_escrow.tournament_id IS NULL
       OR v_target_escrow.enforced IS DISTINCT FROM true
       OR v_target_escrow.closed_at IS NOT NULL
       OR v_target_escrow.close_note IS NOT NULL
       OR v_target_escrow.prize_balance IS NULL
       OR v_target_escrow.prize_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.prize_balance < 0
       OR v_target_escrow.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance, 2)
       OR v_target.prize_pool IS DISTINCT FROM v_target_escrow.prize_balance
       OR v_target_escrow.bounty_balance IS DISTINCT FROM 0::numeric
       OR v_target_escrow.fee_balance IS NULL
       OR v_target_escrow.fee_balance::text IN ('NaN','Infinity','-Infinity')
       OR v_target_escrow.fee_balance < 0
       OR v_target_escrow.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance, 2)
       OR v_target.total_rake IS DISTINCT FROM v_target_escrow.fee_balance
       OR EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'gross_in','fee_entries_in','satellite_fee_in','bounty_in',
             'overlay_in','satellite_in','prize_out','bounty_out','fee_out',
             'refund_prize','refund_bounty','refund_fee',
             'reserve_out','reserve_in'
           ]::text[]) AS component(name)
           CROSS JOIN LATERAL (
             SELECT (to_jsonb(v_target_escrow)->>component.name)::numeric AS amount
           ) AS persisted
          WHERE persisted.amount IS NULL
             OR CASE
                  WHEN persisted.amount::text IN ('NaN','Infinity','-Infinity')
                    THEN true
                  ELSE persisted.amount < 0
                    OR persisted.amount IS DISTINCT FROM round(persisted.amount,2)
                END
       )
     ) THEN
    RAISE EXCEPTION
      'satellite % cannot deliver a target seat against malformed aggregate or escrow state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.tournament_satellite_settlements
    (tournament_id, target_id, target_was_missing, target_contract_version,
     winner_id, receipt_version, completion_kind, field_size, advertised_seats, pool,
     target_buy_in, target_fee, ticket_cost, ticket_award_count,
     seat_count, cash_ticket_count, entry_ticket_count,
     remainder, bubble_user_id, bubble_position,
     source_table_count, source_table_ids, source_seat_count, source_seat_ids,
     released_seat_count, released_seat_ids, source_closed_at,
     source_escrow_closed_at, source_escrow_close_note, settled_at)
  VALUES
    (p_tournament_id, v_target_id, false, NULL,
     p_observed_winner_id, CASE WHEN v_qualification THEN 3 ELSE 2 END,
     CASE WHEN v_qualification THEN 'equal_qualifiers' ELSE 'single_winner' END,
     v_field_size, v_advertised_seats, v_pool,
     v_target_buy_in, v_target_fee, v_ticket_cost, v_ticket_award_count,
     v_seat_count, v_cash_ticket_count, v_entry_ticket_count, v_remainder,
     v_bubble_user_id, v_bubble_position,
     v_source_table_count, v_source_table_ids, v_source_seat_count,
     v_source_seat_ids, v_released_seat_count, v_released_seat_ids,
     v_closeout_at, v_closeout_at, v_source_escrow_close_note, v_closeout_at);

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id
     AND upper(COALESCE(status, '')) IN ('RUNNING','COMPLETING')
     AND COALESCE(prize_pool_finalized, false);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not claim its atomic settlement',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  FOR v_plan_item IN SELECT value FROM jsonb_array_elements(v_plan) LOOP
    v_place := (v_plan_item->>'place')::integer;
    v_delivery_kind := v_plan_item->>'delivery_kind';
    SELECT * INTO v_finisher FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND public.fn_ca_satellite_award_ordinal(tp.tournament_id,tp.user_id) = v_place
       AND tp.user_id = (v_plan_item->>'user_id')::uuid;
    IF v_finisher.id IS NULL THEN
      RAISE EXCEPTION 'satellite % delivery plan lost finisher at place %',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;

    IF v_delivery_kind = 'seat' THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         is_satellite_qualifier, source_satellite_id)
      VALUES
        (v_target_id, v_finisher.user_id, v_finisher.username, 0, 'registered',
         true, p_tournament_id)
      RETURNING id INTO v_registration_id;
      IF v_registration_id IS NULL THEN
        RAISE EXCEPTION 'satellite % seat % returned no registration receipt',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'prize_liability', v_target_id, 'tournaments.prize_pool+total_rake',
         v_ticket_cost, 'tournament_buyin', v_target.club_id, p_tournament_id,
         'tourney:' || p_tournament_id::text || ':seat:'
            || v_finisher.user_id::text || ':pool_transfer',
         'satellite:' || p_tournament_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s delivered as target seat (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'satellite_seat_pool_transfer',
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'registration_id', v_registration_id,
           'seat_value', v_ticket_cost,
           'moved', v_ticket_cost,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2));

      -- The transfer leg puts the complete ticket into target satellite-in.
      -- A positive fee row reclassifies only that fee from target prize to
      -- target fee escrow. A zero-fee target needs no synthetic rake record.
      IF v_target_fee > 0 THEN
        INSERT INTO public.rake_records
          (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
           bbj_contribution, is_tournament, tournament_id, source, metadata)
        VALUES
          (NULL, NULL, v_target.club_id, v_target_fee, v_ticket_cost, 1,
           0, true, v_target_id, 'fn_award_satellite_seat',
           jsonb_build_object(
             'kind', 'satellite_seat_entry_fee',
             'recorded_by', 'fn_settle_satellite_tournament',
             'user_id', v_finisher.user_id,
             'position', v_place,
             'satellite_id', p_tournament_id,
             'registration_id', v_registration_id));
      END IF;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':seat:' || v_finisher.user_id::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_seat', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'registration_id', v_registration_id,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'pool_transfer', v_ticket_cost,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, registration_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'seat', v_ticket_cost,
         v_payout_id, 'satellite_seat', v_payout_key, v_registration_id);
    ELSIF v_delivery_kind = 'ticket' THEN
      -- A four-table cap is not an economic failure and cannot turn a funded
      -- satellite award into wallet chips. Resolve the exact target club and
      -- escrow the funded award in a target-scoped, noncash ticket instead.
      v_ticket_club_id := public.fn_tournament_club_for_user(
        v_finisher.user_id, v_target_id,
        COALESCE(v_target.club_id, v_source.club_id));
      IF v_ticket_club_id IS NULL
         OR (v_target.club_id IS NOT NULL
             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id
             AND NOT EXISTS (
               SELECT 1 FROM public.tournaments tt
               JOIN public.union_clubs uc ON uc.union_id = tt.union_id
              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN
        RAISE EXCEPTION
          'satellite % ticket place % has no exact target club',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      v_ticket_id := gen_random_uuid();
      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      INSERT INTO public.tournament_payouts
        (tournament_id, user_id, "position", amount, source, idempotency_key,
         paid_at, tournament_type, field_size, prize_pool, payout_structure,
         recorded_by, metadata)
      VALUES
        (p_tournament_id, v_finisher.user_id, v_place, v_ticket_cost,
         'satellite_ticket', v_payout_key, now(), v_source.tournament_type,
         v_field_size, v_pool, NULL, 'fn_settle_satellite_tournament',
         jsonb_build_object(
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'satellite_target_id', v_target_id,
           'target_name', v_target.name,
           'target_buy_in', v_target_buy_in,
           'target_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0))
      RETURNING id INTO v_payout_id;

      INSERT INTO public.tournament_tickets
        (id, club_id, issued_by, holder_id, value, status, note,
         redemption_mode, source_tournament_id, source_satellite_id,
         source_refund_entitlement_id, source_satellite_award_place,
         entry_prize, entry_bounty, entry_fee, created_at)
      VALUES
        (v_ticket_id, v_ticket_club_id,
         '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         v_finisher.user_id, v_ticket_cost, 'issued',
         'Four-Table Cap Satellite Award: Tournament Entry Only',
         'tournament_entry_only', v_target_id, p_tournament_id,
         NULL, v_place, v_target_buy_in, 0, v_target_fee,
         transaction_timestamp());

      v_pool_before := round(v_pool - (v_place - 1) * v_ticket_cost, 2);
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         settlement_id, actor_service, description, metadata,
         pre_from_balance, post_from_balance,
         pre_to_balance, post_to_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_tournament_id, 'tournaments.prize_pool',
         'escrow', v_ticket_id, 'satellite tournament entry ticket',
         v_ticket_cost, 'ticket_issue', v_ticket_club_id, p_tournament_id,
         v_payout_key || ':ticket_escrow',
         'satellite-ticket:' || v_ticket_id::text,
         'fn_settle_satellite_tournament',
         format('Satellite ticket place %s held as noncash target entry (%s)',
                v_place, v_ticket_cost),
         jsonb_build_object(
           'kind', 'direct_satellite_entry_ticket',
           'delivery_kind', 'ticket',
           'ticket_id', v_ticket_id,
           'payout_id', v_payout_id,
           'satellite_id', p_tournament_id,
           'satellite_target_id', v_target_id,
           'user_id', v_finisher.user_id,
           'position', v_place,
           'entry_prize', v_target_buy_in,
           'entry_bounty', 0,
           'entry_fee', v_target_fee,
           'wallet_chips_credited', 0,
           'unbacked', 0),
         v_pool_before, round(v_pool_before - v_ticket_cost, 2),
         0, v_ticket_cost)
      RETURNING id INTO v_ticket_ledger_id;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type,
         notes, balance_after, metadata)
      VALUES
        (v_ticket_club_id, NULL, v_finisher.user_id, v_ticket_cost,
         'tournament_ticket_issue',
         'Satellite Award Held As Tournament-Entry Ticket', NULL,
         jsonb_build_object(
           'ticket_id', v_ticket_id,
           'escrow_entity_id', v_ticket_id,
           'holder_id', v_finisher.user_id,
           'value', v_ticket_cost,
           'redemption_mode', 'tournament_entry_only',
           'source_tournament_id', v_target_id,
           'source_satellite_id', p_tournament_id,
           'source_award_place', v_place,
           'payout_id', v_payout_id,
           'ledger_id', v_ticket_ledger_id,
           'idempotency_key', v_payout_key,
           'wallet_chips_credited', 0))
      RETURNING id INTO v_ticket_transaction_id;

      PERFORM public.fn_ca_escrow_apply(
        p_tournament_id, 'direct satellite entry ticket out',
        p_prize_out => v_ticket_cost);

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key, ticket_id)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'ticket',
         v_ticket_cost, v_payout_id, 'satellite_ticket', v_payout_key,
         v_ticket_id);
    ELSIF v_delivery_kind = 'cash' THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'seat', v_place, v_finisher.user_id,
         v_ticket_cost, 0, 'engine.fn_settle_satellite_tournament', NULL)
      RETURNING * INTO v_obligation;

      v_payout_key := 'tourney:' || p_tournament_id::text
                      || ':satellite_ticket:place:' || v_place::text;
      v_credited := public.fn_credit_and_log(
        p_user_id => v_finisher.user_id,
        p_amount => v_ticket_cost,
        p_idempotency_key => v_payout_key,
        p_category => 'prize',
        p_description => 'Satellite ticket paid in cash because target admission was definitively unavailable',
        p_related_entity_id => p_tournament_id,
        p_wallet_type => 'PLAYER',
        p_table_id => NULL,
        p_hand_id => NULL,
        p_payout_position => v_place,
        p_payout_source => 'satellite_ticket');
      IF v_credited IS NOT TRUE THEN
        RAISE EXCEPTION 'satellite % cash ticket % was not a new exact credit',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_obligations o
         SET amount_paid = v_ticket_cost, settled_at = now(), updated_at = now()
       WHERE o.id = v_obligation.id
         AND o.amount_owed = v_ticket_cost AND o.amount_paid = 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'satellite % could not close cash ticket debt %',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      SELECT p.id INTO v_payout_id FROM public.tournament_payouts p
       WHERE p.idempotency_key = v_payout_key
         AND p.tournament_id = p_tournament_id
         AND p.user_id = v_finisher.user_id
         AND p."position" = v_place
         AND p.amount = v_ticket_cost
         AND p.source = 'satellite_ticket';
      IF v_payout_id IS NULL THEN
        RAISE EXCEPTION 'satellite % cash ticket % has no payout row',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;

      INSERT INTO public.tournament_satellite_awards
        (tournament_id, place, user_id, delivery_kind, amount,
         payout_id, payout_source, idempotency_key,
         obligation_id, obligation_kind)
      VALUES
        (p_tournament_id, v_place, v_finisher.user_id, 'cash', v_ticket_cost,
         v_payout_id, 'satellite_ticket', v_payout_key,
         v_obligation.id, 'seat');
    ELSE
      RAISE EXCEPTION 'satellite % has unknown delivery kind % at place %',
        p_tournament_id, v_delivery_kind, v_place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_seat_count > 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE tp.status::text IN ('registered','playing'))
      INTO v_target_count, v_target_live_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_target_id;
    v_target_counter_after := CASE
      WHEN upper(COALESCE(v_target.status, '')) IN ('ANNOUNCED','REGISTERING')
        THEN v_target_live_count
      ELSE v_target_count
    END;
    IF v_target_count IS DISTINCT FROM v_target_count_before + v_seat_count
       OR v_target_live_count IS DISTINCT FROM
            v_target_live_count_before + v_seat_count
       OR v_target_counter_after IS DISTINCT FROM
            v_target_counter_before + v_seat_count THEN
      RAISE EXCEPTION
        'satellite % target roster changed outside its locked delivery plan',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    UPDATE public.tournaments
       SET current_players = v_target.current_players + v_seat_count,
           prize_pool = round(COALESCE(prize_pool, 0)
                              + v_seat_count * v_target_buy_in, 2),
           total_rake = round(COALESCE(total_rake, 0)
                             + v_seat_count * v_target_fee, 2),
           updated_at = now()
     WHERE id = v_target_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not update target aggregate receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT t.id, t.current_players, t.prize_pool, t.total_rake
      INTO v_target_after
      FROM public.tournaments t
     WHERE t.id = v_target_id;
    SELECT * INTO v_target_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = v_target_id
     FOR UPDATE;
    IF v_target_after.id IS NULL
       OR v_target_after.current_players IS DISTINCT FROM
            v_target.current_players + v_seat_count
       OR v_target_after.current_players IS DISTINCT FROM v_target_counter_after
       OR v_target_after.prize_pool IS DISTINCT FROM
            round(v_target.prize_pool + v_seat_count * v_target_buy_in, 2)
       OR v_target_after.total_rake IS DISTINCT FROM
            round(v_target.total_rake + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.tournament_id IS DISTINCT FROM v_target_id
       OR v_target_escrow_after.enforced IS DISTINCT FROM v_target_escrow.enforced
       OR v_target_escrow_after.gross_in IS DISTINCT FROM v_target_escrow.gross_in
       OR v_target_escrow_after.fee_entries_in IS DISTINCT FROM v_target_escrow.fee_entries_in
       OR v_target_escrow_after.satellite_fee_in IS DISTINCT FROM
            round(v_target_escrow.satellite_fee_in
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.bounty_in IS DISTINCT FROM v_target_escrow.bounty_in
       OR v_target_escrow_after.overlay_in IS DISTINCT FROM v_target_escrow.overlay_in
       OR v_target_escrow_after.satellite_in IS DISTINCT FROM
            round(v_target_escrow.satellite_in
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.prize_out IS DISTINCT FROM v_target_escrow.prize_out
       OR v_target_escrow_after.bounty_out IS DISTINCT FROM v_target_escrow.bounty_out
       OR v_target_escrow_after.fee_out IS DISTINCT FROM v_target_escrow.fee_out
       OR v_target_escrow_after.refund_prize IS DISTINCT FROM v_target_escrow.refund_prize
       OR v_target_escrow_after.refund_bounty IS DISTINCT FROM v_target_escrow.refund_bounty
       OR v_target_escrow_after.refund_fee IS DISTINCT FROM v_target_escrow.refund_fee
       OR v_target_escrow_after.reserve_out IS DISTINCT FROM v_target_escrow.reserve_out
       OR v_target_escrow_after.reserve_in IS DISTINCT FROM v_target_escrow.reserve_in
       OR v_target_escrow_after.prize_balance IS DISTINCT FROM
            round(v_target_escrow.prize_balance
                  + v_seat_count * v_target_buy_in, 2)
       OR v_target_escrow_after.bounty_balance IS DISTINCT FROM v_target_escrow.bounty_balance
       OR v_target_escrow_after.fee_balance IS DISTINCT FROM
            round(v_target_escrow.fee_balance
                  + v_seat_count * v_target_fee, 2)
       OR v_target_escrow_after.opened_at IS DISTINCT FROM v_target_escrow.opened_at
       OR v_target_escrow_after.opened_from IS DISTINCT FROM v_target_escrow.opened_from
       OR v_target_escrow_after.closed_at IS DISTINCT FROM v_target_escrow.closed_at
       OR v_target_escrow_after.close_note IS DISTINCT FROM v_target_escrow.close_note THEN
      RAISE EXCEPTION
        'satellite % target aggregate or escrow delta is not the exact delivered seat value',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF v_remainder > 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'satellite_remainder', v_bubble_position,
       v_bubble_user_id, v_remainder, 0,
       'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obligation;

    v_payout_key := 'tourney:' || p_tournament_id::text
                    || ':satellite_remainder:place:'
                    || v_bubble_position::text;
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bubble_user_id,
      p_amount => v_remainder,
      p_idempotency_key => v_payout_key,
      p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => p_tournament_id,
      p_wallet_type => 'PLAYER',
      p_table_id => NULL,
      p_hand_id => NULL,
      p_payout_position => v_bubble_position,
      p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_obligations
       SET amount_paid = v_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obligation.id
       AND tournament_id = p_tournament_id
       AND kind = 'satellite_remainder' AND place = v_bubble_position
       AND user_id = v_bubble_user_id
       AND amount_owed = v_remainder
       AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not close one exact remainder debt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT p.id INTO v_payout_id
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_bubble_user_id
       AND p."position" = v_bubble_position
       AND p.amount = v_remainder
       AND p.source = 'satellite_remainder'
       AND p.idempotency_key = v_payout_key;
    IF v_payout_id IS NULL THEN
      RAISE EXCEPTION 'satellite % remainder has no exact payout row',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount,
       payout_id, payout_source, payout_position, idempotency_key,
       obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES
      (p_tournament_id, v_bubble_user_id, v_bubble_position, v_remainder,
       v_payout_id, 'satellite_remainder', v_bubble_position, v_payout_key,
       v_obligation.id, 'satellite_remainder', v_bubble_position, 'atomic');
  END IF;

  UPDATE public.tournament_players SET prize = 0
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_players SET prize = v_ticket_cost
   WHERE tournament_id = p_tournament_id
     AND public.fn_ca_satellite_award_ordinal(tournament_id,user_id)
           BETWEEN 1 AND v_ticket_award_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_ticket_award_count THEN
    RAISE EXCEPTION 'satellite % stamped % ticket caches, expected %',
      p_tournament_id, v_rows, v_ticket_award_count USING ERRCODE = 'P0404';
  END IF;
  IF v_remainder > 0 THEN
    UPDATE public.tournament_players SET prize = v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_bubble_user_id AND position = v_bubble_position;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite % could not stamp the single bubble cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), round(COALESCE(sum(p.amount), 0), 2)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id;
  IF v_payout_count <> (v_ticket_award_count
                        + CASE WHEN v_remainder > 0 THEN 1 ELSE 0 END)
     OR v_paid IS DISTINCT FROM v_pool THEN
    RAISE EXCEPTION 'satellite % paid % of locked pool % across % rows',
      p_tournament_id, v_paid, v_pool, v_payout_count
      USING ERRCODE = 'P0404';
  END IF;

  v_rake_result := public.fn_settle_tournament_rake(
    p_tournament_id, 'engine.fn_settle_satellite_tournament');
  IF COALESCE((v_rake_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_rake_result->>'amount')::numeric, 0) > 0
         AND COALESCE((v_rake_result->>'attributed')::boolean, false) IS NOT TRUE) THEN
    RAISE EXCEPTION 'satellite % rake did not settle and attribute exactly: %',
      p_tournament_id, v_rake_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_source_escrow FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_source_escrow.prize_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.bounty_balance IS DISTINCT FROM 0::numeric
     OR v_source_escrow.fee_balance IS DISTINCT FROM 0::numeric THEN
    RAISE EXCEPTION
      'satellite % settlement leaves escrow prize %, bounty %, fee %',
      p_tournament_id, v_source_escrow.prize_balance,
      v_source_escrow.bounty_balance, v_source_escrow.fee_balance
      USING ERRCODE = 'P0404';
  END IF;

  -- The atomic authority, not the legacy lifecycle observer, owns the escrow
  -- close. Stamp the exact zero proof before publishing COMPLETED so the
  -- receipt remains valid after that observer is retired by the terminal
  -- cutover migration.
  UPDATE public.tournament_escrow
     SET closed_at = v_closeout_at,
         close_note = v_source_escrow_close_note,
         updated_at = now()
   WHERE tournament_id = p_tournament_id
     AND closed_at IS NULL
     AND close_note IS NULL
     AND prize_balance = 0
     AND bounty_balance = 0
     AND fee_balance = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit its exact escrow close',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  -- Source felt closure is part of the money commit. This runs after tickets,
  -- the single Bubble remainder, rake and escrow so any table/seat refusal
  -- rolls all of those effects back. The pre-payer identity arrays prevent a
  -- concurrent table or seat from appearing outside the receipt.
  UPDATE public.table_seats ts
     SET left_at = v_closeout_at,
         status = 'left',
         leave_pending = false,
         is_sitting_out = false,
         is_away = false,
         sit_out_at = NULL,
         scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_released_seat_ids)
     AND ts.left_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_released_seat_count THEN
    RAISE EXCEPTION 'satellite % released % source seats, expected %',
      p_tournament_id, v_rows, v_released_seat_count USING ERRCODE = '40001';
  END IF;

  -- Elimination already gave predeparted seats a durable departure time. Close
  -- only their mutable occupancy flags here; never rewrite that historical time
  -- or fire left_at-specific effects a second time.
  UPDATE public.table_seats ts
     SET status = 'left', leave_pending = false, is_sitting_out = false,
         is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
   WHERE ts.id = ANY(v_source_seat_ids)
     AND ts.left_at IS NOT NULL
     AND (ts.status IS DISTINCT FROM 'left'
       OR ts.leave_pending IS DISTINCT FROM false
       OR ts.is_sitting_out IS DISTINCT FROM false
       OR ts.is_away IS DISTINCT FROM false
       OR ts.sit_out_at IS NOT NULL
       OR ts.scheduled_leave_hands IS NOT NULL);

  -- Mark the game terminal only after its seats are released, but before its
  -- tables close. The existing table-status trigger treats a close under a
  -- COMPLETING tournament as an accidental live-game close and files an
  -- incident. COMPLETED is therefore the canonical parent-before-child order.
  -- A later table-close refusal still rolls this status and all money back.
  UPDATE public.tournaments
     SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true,
         current_players = 0, on_break = false,
         break_started_at = NULL, break_ends_at = NULL, updated_at = now()
   WHERE id = p_tournament_id AND upper(COALESCE(status, '')) = 'COMPLETING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'satellite % could not commit COMPLETING to COMPLETED',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.tables tb
     SET status = 'closed',
         lifecycle = 'closed',
         current_players = 0,
         terminal_closed_at = v_closeout_at,
         updated_at = now()
   WHERE tb.id = ANY(v_source_table_ids)
     AND tb.tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM v_source_table_count
     OR EXISTS (
       SELECT 1 FROM public.tables tb
        WHERE tb.tournament_id = p_tournament_id
          AND (lower(COALESCE(tb.status::text, '')) <> 'closed'
            OR lower(COALESCE(tb.lifecycle, '')) <> 'closed'
            OR tb.current_players IS DISTINCT FROM 0)
     ) OR EXISTS (
       SELECT 1
        FROM public.table_seats ts
         JOIN public.tables tb ON tb.id = ts.table_id
        WHERE tb.tournament_id = p_tournament_id
          AND (ts.left_at IS NULL
            OR ts.status IS DISTINCT FROM 'left'
            OR ts.leave_pending IS DISTINCT FROM false
            OR ts.is_sitting_out IS DISTINCT FROM false
            OR ts.is_away IS DISTINCT FROM false
            OR ts.sit_out_at IS NOT NULL
            OR ts.scheduled_leave_hands IS NOT NULL)
     ) THEN
    RAISE EXCEPTION
      'satellite % did not durably release every source seat and close every source table',
      p_tournament_id USING ERRCODE = '40001';
  END IF;

  RETURN public.fn_ca_satellite_settlement_receipt(
    p_tournament_id, p_observed_winner_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_with_seat_authority(
  p_tournament_id uuid,p_observed_winner_id uuid,p_qualified_user_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $satellite_with_final_seat_authority$
DECLARE
  v_prior_money_path text:=COALESCE(current_setting('app.money_path',true),'');
  v_token uuid;
  v_result jsonb;
  v_target_id uuid;
  v_target_status text;
  v_user_id uuid;
  v_award record;
  v_assignment jsonb;
  v_seat_award_count integer;
  v_assigned_count integer:=0;
  v_exact_count integer;
  v_was_already_settled boolean:=false;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite settlement requires service authority'
      USING ERRCODE='28000';
  END IF;

  -- A RUNNING target award changes the beneficiary from registered to seated
  -- in this same transaction. Take the canonical acquisition prefix before
  -- the source exit opener or the settlement core can lock any roster/chair.
  -- Every source player is bounded by the locked field and is acquired in UUID
  -- order; the exact award subset is not known until the core atomically fixes
  -- the target admission plan.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM pg_advisory_xact_lock_shared(530090,1);
  SELECT true INTO v_was_already_settled
    FROM public.tournament_satellite_settlements settlement
   WHERE settlement.tournament_id=p_tournament_id;
  v_was_already_settled:=FOUND;
  IF NOT v_was_already_settled THEN
    FOR v_user_id IN
      SELECT DISTINCT tp.user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND tp.user_id IS NOT NULL
       ORDER BY tp.user_id
    LOOP
      PERFORM public.fn_lock_daily_mission_user(v_user_id);
    END LOOP;
  END IF;

  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'satellite_finish',NULL);
  BEGIN
    PERFORM set_config('app.money_path','fn_settle_satellite_tournament',true);
    v_result:=public.fn_ca_settle_satellite_terminal(
      p_tournament_id,p_observed_winner_id,p_qualified_user_ids);
    PERFORM set_config('app.money_path',v_prior_money_path,true);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite core returned no successful exact receipt: %',
        v_result USING ERRCODE='P0404';
    END IF;

    SELECT settlement.target_id,upper(COALESCE(target.status::text,''))
      INTO STRICT v_target_id,v_target_status
      FROM public.tournament_satellite_settlements settlement
      JOIN public.tournaments target ON target.id=settlement.target_id
     WHERE settlement.tournament_id=p_tournament_id
     FOR UPDATE OF target;
    IF (v_result->>'target_id')::uuid IS DISTINCT FROM v_target_id THEN
      RAISE EXCEPTION
        'satellite core target disagrees with its immutable settlement header'
        USING ERRCODE='P0404';
    END IF;

    SELECT count(*)::integer INTO v_seat_award_count
      FROM public.tournament_satellite_awards award
     WHERE award.tournament_id=p_tournament_id
       AND award.delivery_kind='seat';
    IF (v_result->>'seat_count')::integer IS DISTINCT FROM v_seat_award_count THEN
      RAISE EXCEPTION
        'satellite core seat count disagrees with its immutable award rows'
        USING ERRCODE='P0404';
    END IF;

    -- REGISTERING targets deliberately retain zero-chip registrations until
    -- launch. A RUNNING target has no such intermediate state: choose/create
    -- one legal chair and promote every funded qualifier before the deferred
    -- reciprocal roster-seat invariant is allowed to run at commit.
    IF NOT v_was_already_settled AND v_target_status='RUNNING' THEN
      FOR v_award IN
        SELECT award.user_id,award.registration_id,award.place
          FROM public.tournament_satellite_awards award
         WHERE award.tournament_id=p_tournament_id
           AND award.delivery_kind='seat'
         ORDER BY award.user_id,award.place
      LOOP
        v_assignment:=public.fn_assign_tournament_player_seat_atomic(
          v_target_id,v_award.user_id,NULL,NULL);
        IF COALESCE((v_assignment->>'ok')::boolean,false) IS NOT TRUE
           OR (v_assignment->>'tournament_id')::uuid IS DISTINCT FROM v_target_id
           OR (v_assignment->>'user_id')::uuid IS DISTINCT FROM v_award.user_id
           OR v_assignment->>'table_id' IS NULL
           OR v_assignment->>'seat_id' IS NULL
           OR v_assignment->>'seat_number' IS NULL
           OR v_assignment->>'stack' IS NULL
           OR (v_assignment->>'stack')::numeric<=0 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % has no exact atomic chair receipt: %',
            v_award.place,v_assignment USING ERRCODE='P0404';
        END IF;

        SELECT count(*)::integer INTO v_exact_count
          FROM public.tournament_players tp
          JOIN public.table_seats seat
            ON seat.table_id=tp.table_id
           AND seat.seat_number=tp.seat_number
           AND seat.user_id=tp.user_id
           AND seat.left_at IS NULL
          JOIN public.tables target_table
            ON target_table.id=seat.table_id
           AND target_table.tournament_id=v_target_id
         WHERE tp.id=v_award.registration_id
           AND tp.tournament_id=v_target_id
           AND tp.user_id=v_award.user_id
           AND tp.status::text='playing'
           AND COALESCE(tp.chips,0)>0
           AND COALESCE(tp.is_satellite_qualifier,false)
           AND tp.source_satellite_id=p_tournament_id
           AND seat.id=(v_assignment->>'seat_id')::uuid
           AND seat.table_id=(v_assignment->>'table_id')::uuid
           AND seat.seat_number=(v_assignment->>'seat_number')::integer
           AND seat.stack::numeric IS NOT DISTINCT FROM tp.chips::numeric
           AND tp.chips::numeric IS NOT DISTINCT FROM
                 (v_assignment->>'stack')::numeric
           AND (SELECT count(*)
                  FROM public.table_seats exact_seat
                  JOIN public.tables exact_table
                    ON exact_table.id=exact_seat.table_id
                   AND exact_table.tournament_id=v_target_id
                 WHERE exact_seat.user_id=v_award.user_id
                   AND exact_seat.left_at IS NULL)=1;
        IF v_exact_count<>1 THEN
          RAISE EXCEPTION
            'RUNNING satellite target award % did not become one exact funded roster-seat generation',
            v_award.place USING ERRCODE='P0404';
        END IF;
        v_assigned_count:=v_assigned_count+1;
      END LOOP;
      IF v_assigned_count<>v_seat_award_count THEN
        RAISE EXCEPTION
          'RUNNING satellite target assigned % of % immutable seat awards',
          v_assigned_count,v_seat_award_count USING ERRCODE='P0404';
      END IF;
    END IF;

    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.money_path',v_prior_money_path,true);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$satellite_with_final_seat_authority$;

-- All legacy money paths delegate to the same payment implementation.
CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(
  p_tournament_id uuid,p_observed_winner_id uuid
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp
AS $legacy_money$ SELECT public.fn_ca_settle_satellite_terminal($1,$2,NULL); $legacy_money$;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_tournament(
  p_tournament_id uuid,p_observed_winner_id uuid
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp
AS $legacy_terminal$ SELECT public.fn_ca_settle_satellite_with_seat_authority($1,$2,NULL); $legacy_terminal$;

CREATE FUNCTION public.fn_complete_satellite_qualification(
  p_tournament_id uuid,p_qualified_user_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='30s'
AS $qualification$
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite qualification requires service authority' USING ERRCODE='28000';
  END IF;
  RETURN public.fn_ca_settle_satellite_with_seat_authority(
    p_tournament_id,NULL,p_qualified_user_ids);
END;
$qualification$;

CREATE FUNCTION public.fn_resolve_satellite_qualification_outcome(
  p_tournament_id uuid,p_qualified_user_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='30s'
AS $qualification_outcome$
DECLARE v_status text; v_expected uuid[]; v_actual uuid[]; v_receipt jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite qualification outcome requires service authority' USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR cardinality(p_qualified_user_ids)<2
     OR cardinality(p_qualified_user_ids) IS NULL
     OR array_position(p_qualified_user_ids,NULL) IS NOT NULL
     OR (SELECT count(DISTINCT id) FROM unnest(p_qualified_user_ids) AS requested(id))
          <>cardinality(p_qualified_user_ids) THEN
    RAISE EXCEPTION 'qualification outcome requires distinct cohort ids' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_expected FROM unnest(p_qualified_user_ids) AS requested(id);
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF EXISTS(SELECT 1 FROM public.tournament_satellite_settlements s WHERE s.tournament_id=p_tournament_id) THEN
    SELECT array_agg(q.user_id ORDER BY q.user_id) INTO v_actual
      FROM public.tournament_satellite_qualifiers q WHERE q.tournament_id=p_tournament_id;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'stored qualification cohort differs from request' USING ERRCODE='40001';
    END IF;
    -- Receipt acquisition keeps target-before-source ordering. Never hold
    -- the source alone before the verifier takes the target admission lock.
    v_receipt:=public.fn_ca_satellite_settlement_receipt(p_tournament_id,NULL);
    v_status:='COMPLETED';
  ELSE
    SELECT upper(t.status::text) INTO v_status FROM public.tournaments t
     WHERE t.id=p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'satellite source is absent' USING ERRCODE='P0002'; END IF;
    IF v_status NOT IN ('RUNNING','COMPLETING') THEN
      RAISE EXCEPTION 'terminal source without an exact qualification receipt' USING ERRCODE='P0404';
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'tournament_id',p_tournament_id,
    'completion_kind','equal_qualifiers','qualified_user_ids',to_jsonb(v_expected),
    'satellite_committed',v_receipt IS NOT NULL,
    'definitively_not_committed',v_receipt IS NULL,'status',v_status,'receipt',v_receipt);
END;
$qualification_outcome$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_satellite_settlement_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_terminal(uuid,uuid,uuid[],boolean)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_settle_satellite_with_seat_authority(uuid,uuid,uuid[])
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_complete_satellite_qualification(uuid,uuid[])
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_resolve_satellite_qualification_outcome(uuid,uuid[])
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_satellite_qualification(uuid,uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_resolve_satellite_qualification_outcome(uuid,uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_rank_survivors(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ranked integer := 0;
  v_bound  integer;
BEGIN
  -- Equal qualifiers are an immutable terminal cohort, not unranked losers.
  -- The atomic payer writes this versioned header and exact cohort before its
  -- status flip. Never let a legacy completion/recovery caller invent places.
  IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements h
       WHERE h.tournament_id=p_tournament_id AND h.receipt_version=3
         AND h.completion_kind='equal_qualifiers' AND h.winner_id IS NULL) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_satellite_settlements h
      JOIN public.tournament_satellite_qualification_boundaries b
        ON b.tournament_id=h.tournament_id
      WHERE h.tournament_id=p_tournament_id
        AND (SELECT array_agg(q.user_id ORDER BY q.user_id)
          FROM public.tournament_satellite_qualifiers q
          WHERE q.tournament_id=p_tournament_id)=b.qualified_user_ids
        AND cardinality(b.qualified_user_ids)=h.ticket_award_count
        AND NOT EXISTS (
          SELECT 1 FROM public.tournament_satellite_qualifiers q
          LEFT JOIN public.tournament_players tp ON tp.id=q.registration_id
          WHERE q.tournament_id=p_tournament_id AND (
            tp.user_id IS DISTINCT FROM q.user_id
            OR tp.tournament_id IS DISTINCT FROM p_tournament_id
            OR tp.status::text IS DISTINCT FROM 'winner' OR tp.position IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'equal qualifier terminal cohort is incomplete'
        USING ERRCODE='P0404';
    END IF;
    RETURN 0;
  END IF;
  SELECT GREATEST(COUNT(*), COALESCE(MAX(position), 0))
    INTO v_bound
    FROM tournament_players
   WHERE tournament_id = p_tournament_id;

  IF COALESCE(v_bound, 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH taken AS (
    SELECT DISTINCT position
      FROM tournament_players
     WHERE tournament_id = p_tournament_id
       AND position IS NOT NULL
  ),
  survivors AS (
    SELECT id,
           row_number() OVER (
             ORDER BY COALESCE(chips, 0) DESC,
                      COALESCE(chip_count, 0) DESC,
                      registered_at ASC,
                      id ASC
           ) AS rn
      FROM tournament_players
     WHERE tournament_id = p_tournament_id
       AND position IS NULL
  ),
  free AS (
    SELECT g AS pos, row_number() OVER (ORDER BY g) AS rn
      FROM generate_series(1, v_bound) g
     WHERE NOT EXISTS (SELECT 1 FROM taken tk WHERE tk.position = g)
  )
  UPDATE tournament_players tp
     SET position      = f.pos,
         status        = CASE WHEN f.pos = 1 THEN 'winner' ELSE 'eliminated' END,
         eliminated_at = CASE WHEN f.pos = 1 THEN tp.eliminated_at
                              ELSE COALESCE(tp.eliminated_at, now()) END
    FROM survivors s
    JOIN free f ON f.rn = s.rn
   WHERE tp.id = s.id;

  GET DIAGNOSTICS v_ranked = ROW_COUNT;
  RETURN v_ranked;
END;
$function$
;

CREATE FUNCTION public.fn_prepare_satellite_qualification(
  p_tournament_id uuid,p_qualified_user_ids uuid[],p_lease_generation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='30s'
AS $prepare_qualification$
DECLARE v_result jsonb; v_prior text:=COALESCE(current_setting('app.money_path',true),'');
  v_prior_qualification text:=COALESCE(current_setting('app.atomic_satellite_qualification',true),'');
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'satellite boundary requires service authority' USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  -- Fence the reviewed claimant's FOR UPDATE while allowing the owner's
  -- FOR NO KEY UPDATE heartbeat. No prepare path mutates or upgrades this row.
  -- Re-evaluate freshness after admission and again after later cohort locks.
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id=p_tournament_id FOR KEY SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM public.engine_tournament_leases l
     WHERE l.tournament_id=p_tournament_id AND l.lease_generation=p_lease_generation
       AND l.protocol_version=2 AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds'
  ) THEN
    RAISE EXCEPTION 'satellite qualification lost its engine lease generation'
      USING ERRCODE='40001';
  END IF;
  PERFORM set_config('app.money_path','fn_settle_satellite_tournament',true);
  PERFORM set_config('app.atomic_satellite_qualification',p_tournament_id::text||':'||p_lease_generation::text,true);
  BEGIN
    v_result:=public.fn_ca_settle_satellite_terminal(
      p_tournament_id,NULL,p_qualified_user_ids,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.money_path',v_prior,true);
    PERFORM set_config('app.atomic_satellite_qualification',v_prior_qualification,true);
    RAISE;
  END;
  PERFORM set_config('app.money_path',v_prior,true);
    PERFORM set_config('app.atomic_satellite_qualification',v_prior_qualification,true);
  RETURN v_result;
END;
$prepare_qualification$;
REVOKE ALL ON FUNCTION public.fn_prepare_satellite_qualification(uuid,uuid[],uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prepare_satellite_qualification(uuid,uuid[],uuid) TO service_role;

-- Presentation reads exactly the authenticated participant's committed
-- qualification. No caller can provide another participant identity.
CREATE FUNCTION public.fn_get_my_satellite_qualification(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $own_qualification$
  SELECT jsonb_build_object('tournament_id',q.tournament_id,'user_id',q.user_id,
    'completion_kind',h.completion_kind,'target_id',h.target_id,
    'amount',a.amount,'delivery_kind',a.delivery_kind,'qualified_at',q.qualified_at,
    'registration_id',a.registration_id,'ticket_id',a.ticket_id)
    FROM public.tournament_satellite_qualifiers q
    JOIN public.tournament_satellite_settlements h ON h.tournament_id=q.tournament_id
    JOIN public.tournament_satellite_awards a
      ON a.tournament_id=q.tournament_id AND a.user_id=q.user_id AND a.place=q.award_ordinal
    JOIN public.tournament_players tp ON tp.id=q.registration_id
    JOIN public.tournaments t ON t.id=q.tournament_id
   WHERE q.tournament_id=p_tournament_id AND q.user_id=auth.uid()
     AND h.receipt_version=3 AND h.completion_kind='equal_qualifiers' AND h.winner_id IS NULL
     AND upper(t.status::text)='COMPLETED' AND tp.status::text='winner'
     AND tp.position IS NULL AND tp.tournament_id=q.tournament_id AND tp.user_id=q.user_id
     AND a.amount=h.ticket_cost;
$own_qualification$;
REVOKE ALL ON FUNCTION public.fn_get_my_satellite_qualification(uuid)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_my_satellite_qualification(uuid) TO authenticated;

-- Keep the installed service-only ranking authority explicit on replacement.
REVOKE ALL ON FUNCTION public.fn_rank_survivors(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rank_survivors(uuid) TO service_role;

COMMIT;
