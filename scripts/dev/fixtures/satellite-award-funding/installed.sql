-- Current installed award/transfer authorities; base registration fixture supplies real money writers.
-- Empty terminal receipt shapes support read-only guards, not terminal settlement certification.
-- Current rake marker column read by the installed immutable-rake guard.
ALTER TABLE public.rake_records ADD COLUMN terminal_closed_at timestamptz;
CREATE TABLE public.tournament_terminal_settlements(tournament_id uuid PRIMARY KEY);
CREATE TABLE public.tournament_satellite_settlements(tournament_id uuid PRIMARY KEY);
CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY);
-- Installed Body MD5: b0a05e8e90bced99d121375c9a7b9c88
CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text DEFAULT NULL::text, p_position integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
  v_existing_q boolean;
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
  v_split record;
  -- Lane G (2026-09-02): the seat is paid from the satellite's own pool.
  v_sat_pool numeric;
  v_moved    numeric := 0;
  v_short    numeric := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         bounty_amount, is_bounty, is_pko, is_mystery_bounty,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- A previously committed award is a replay even if admission later closed.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

  IF FOUND THEN

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END IF;

  -- One database predicate owns level-based and minutes-only late entry.
  -- ANNOUNCED/REGISTERING targets are open until their pool is finalized;
  -- RUNNING targets must pass the same locked gate as a paid registrant.
  IF v_t.status IN ('ANNOUNCED','REGISTERING') THEN
    IF COALESCE(v_t.prize_pool_finalized,false) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_pool_finalized');
    END IF;
  ELSIF v_t.status='RUNNING' THEN
    IF NOT public.fn_tournament_late_registration_open(p_target_id) THEN
      RETURN jsonb_build_object('ok',false,'reason','target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok',false,'reason','target_closed');
  END IF;

  SELECT count(*) INTO v_field
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_target_id;
  IF v_t.max_players IS NOT NULL AND v_field>=v_t.max_players THEN
    RETURN jsonb_build_object('ok',false,'reason','target_full');
  END IF;

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount,
    COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false) OR COALESCE(v_t.is_mystery_bounty,false));
  IF v_split.prize < 0 OR v_split.bounty < 0 OR v_split.rake < 0
     OR v_split.charge <> v_split.prize + v_split.bounty + v_split.rake THEN
    RAISE EXCEPTION 'Invalid satellite target entry split' USING ERRCODE='23514';
  END IF;
  -- Open both escrows before journal triggers observe this award's writes.
  PERFORM public.fn_ca_escrow_apply(p_target_id, 'before satellite seat');
  PERFORM public.fn_ca_escrow_apply(p_satellite_id, 'before satellite seat');

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id, current_bounty)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id, v_split.bounty)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing - the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    --
    -- AND SAY WHEN YOU DO NOT KNOW. source_satellite_id has only been written
    -- since 2026-08-30; every seat awarded before that has it NULL. Collapsing
    -- NULL to FALSE answers "a different satellite seated them" and sends the
    -- caller down the branch that pays cash, on top of a seat this satellite
    -- may well have awarded. NULL means unknown, and the caller pays nothing.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + v_split.prize,
         bounty_pool     = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee', 'entry_split_version', 2,
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  v_value := round(COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 2);

  /* THE SEAT IS PAID FROM THE SATELLITE'S OWN POOL (Lane G, 2026-09-02).
     The target was just credited buy_in + fee. Until now nobody was debited,
     so the target owed prize money it never received and the satellite kept
     a pool it had already spent. Move the seat value out of the satellite's
     prize_pool, and write the one ledger row that says where it went.

     Every newly awarded seat must have a fully funded transfer and payout
     receipt in this transaction. Existing awards still replay above. */
  BEGIN
    SELECT prize_pool INTO v_sat_pool
      FROM public.tournaments
     WHERE id = p_satellite_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Satellite source tournament does not exist' USING ERRCODE = '23503';
    END IF;
    v_sat_pool := round(COALESCE(v_sat_pool, 0), 2);
    v_moved := LEAST(GREATEST(v_sat_pool, 0), v_value);
    v_short := round(v_value - v_moved, 2);

    IF v_moved > 0 THEN
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) - v_moved, 2)
       WHERE id = p_satellite_id;

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_satellite_id, 'tournaments.prize_pool',
         'prize_liability', p_target_id, 'tournaments.prize_pool+total_rake',
         v_moved, 'tournament_buyin', v_t.club_id, p_satellite_id,
         'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text || ':pool_transfer',
         format('Satellite seat: %s paid from the satellite pool into %s (buy-in %s + fee %s) for the seat of %s',
                v_moved, COALESCE(v_t.name, p_target_id::text),
                COALESCE(v_t.buy_in_amount, 0), COALESCE(v_t.buy_in_fee, 0), p_user_id),
         jsonb_build_object('kind', 'satellite_seat_pool_transfer',
                            'entry_split_version', 2, 'entry_prize', v_split.prize,
                            'entry_bounty', v_split.bounty, 'entry_fee', v_split.rake,
                            'satellite_id', p_satellite_id,
                            'satellite_target_id', p_target_id,
                            'user_id', p_user_id,
                            'registration_id', v_seat_id,
                            'seat_value', v_value,
                            'moved', v_moved,
                            'unbacked', v_short),
         v_sat_pool, round(v_sat_pool - v_moved, 2))
      ;
    END IF;

    IF v_short > 0 THEN
      RAISE EXCEPTION 'Satellite pool cannot fund the entire seat: required %, available %',
        v_value, v_sat_pool USING ERRCODE = '23514';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The seat, target counters, source debit and journal are indivisible.
    RAISE;
  END;

  /* The payout receipt commits with the new seat and its funded transfer. */
  BEGIN
    SELECT tournament_type, prize_pool INTO v_sat
      FROM public.tournaments WHERE id = p_satellite_id;
    SELECT count(*) INTO v_field
      FROM public.tournament_players WHERE tournament_id = p_satellite_id;
    v_value := COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0);

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
    VALUES
      (p_satellite_id, p_user_id, p_position, v_value, 'satellite_seat',
       'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text,
       now(), v_sat.tournament_type, v_field,
       -- The COLLECTED pool, as every earlier row recorded it: read before
       -- this seat's transfer reduced it.
       COALESCE(v_sat_pool, v_sat.prize_pool),
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0),
                          'entry_split_version', 2, 'entry_prize', v_split.prize,
                          'entry_bounty', v_split.bounty,
                          'pool_transfer', v_moved,
                          'unbacked', v_short))
    ;
  EXCEPTION WHEN OTHERS THEN
    -- An award without its payout receipt must roll back in full.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty,
    'rake', COALESCE(v_t.buy_in_fee, 0),
    'pool_transfer', v_moved,
    'unbacked', v_short);
END;
$function$;

-- Installed Body MD5: a9150743200c8e366964a7867e8c23f9
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_ca_escrow_apply(NEW.tournament_id, 'satellite seat out', p_prize_out => round(COALESCE(NEW.amount, 0), 2));
  RETURN NULL;
END;
$function$;

-- Installed Body MD5: 227d11db5fe0b4ad403b2f45d098a166
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_seat_transfer_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metadata->>'entry_split_version' = '2' THEN
    IF round(NEW.amount,2) IS DISTINCT FROM round((NEW.metadata->>'entry_prize')::numeric
        + (NEW.metadata->>'entry_bounty')::numeric + (NEW.metadata->>'entry_fee')::numeric,2)
       OR (NEW.metadata->>'entry_prize')::numeric < 0
       OR (NEW.metadata->>'entry_bounty')::numeric < 0
       OR (NEW.metadata->>'entry_fee')::numeric < 0 THEN
      RAISE EXCEPTION 'Satellite transfer does not match its funded split' USING ERRCODE='23514';
    END IF;
    PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite split entry',
      p_gross_in => round(NEW.amount - (NEW.metadata->>'entry_fee')::numeric,2),
      p_bounty_in => (NEW.metadata->>'entry_bounty')::numeric);
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'satellite seat in', p_satellite_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;

-- Installed Body MD5: cbe5f2c1f5947a8b1d2f85de5c1abe0d
CREATE OR REPLACE FUNCTION public.fn_satellite_target_player_provenance_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_status text;
  v_acquisition_key bigint:=hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_acquisition_root boolean:=false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.is_satellite_qualifier IS DISTINCT FROM OLD.is_satellite_qualifier
       OR NEW.source_satellite_id IS DISTINCT FROM OLD.source_satellite_id) THEN
    RAISE EXCEPTION 'tournament player ownership and entry provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,OLD.source_satellite_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source_satellite_id IS NOT NULL THEN
    v_source_ids := array_append(v_source_ids,NEW.source_satellite_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = OLD.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT a.tournament_id INTO v_source_id
      FROM public.tournament_satellite_awards a
     WHERE a.registration_id = NEW.id;
    IF v_source_id IS NOT NULL THEN
      v_source_ids := array_append(v_source_ids,v_source_id);
    END IF;
  END IF;
  -- Ticket admission and an exact pre-start ticket return are the only
  -- lifecycle edges that may respectively add or remove provenance after the
  -- source satellite has closed. Both enclosing authorities acquire the same
  -- terminal-global transaction lock before touching the target registration.
  -- The unregistration wrapper additionally exposes its exact operation while
  -- the owner-only core is active; a raw DELETE therefore cannot masquerade as
  -- a ticket return merely by reaching this trigger.
  IF TG_OP IN ('INSERT','DELETE') THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid=pg_backend_pid()
         AND l.locktype='advisory'
         AND l.database=(
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname=current_database())
         AND l.classid=(((v_acquisition_key>>32)&4294967295)::oid)
         AND l.objid=((v_acquisition_key&4294967295)::oid)
         AND l.objsubid=1
         AND l.mode='ExclusiveLock'
         AND l.granted)
      INTO v_owns_acquisition_root;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    -- The rolling satellite authority owns target before source. Take both
    -- roots in that same order so a direct provenance insert cannot invert
    -- the pair across its specialized and generic guards.
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite provenance'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOREACH v_source_id IN ARRAY v_source_ids LOOP
      IF v_source_id IS DISTINCT FROM NEW.tournament_id THEN
        SELECT upper(COALESCE(t.status::text,'')) INTO v_status
          FROM public.tournaments t
         WHERE t.id = v_source_id FOR SHARE;
        IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
           AND NOT COALESCE(v_owns_acquisition_root,false) THEN
          RAISE EXCEPTION 'completed satellite target provenance is immutable'
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NOT (
       (TG_OP='INSERT' AND COALESCE(v_owns_acquisition_root,false))
       OR (TG_OP='DELETE'
           AND COALESCE(v_owns_acquisition_root,false)
           AND COALESCE(current_setting(
                 'app.tournament_seat_exit_operation',true),'')='unregister')
     )
     AND EXISTS (
    SELECT 1 FROM unnest(v_source_ids) source(id)
     WHERE public.fn_ca_has_committed_tournament_receipt(source.id)
  ) THEN
    RAISE EXCEPTION 'completed satellite target provenance is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- Installed Body MD5: 640f0819d80f769ce4f224413fd359b5
CREATE OR REPLACE FUNCTION public.fn_satellite_target_rake_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_source_id uuid;
  v_new_source_id uuid;
  v_text text;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_text := OLD.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_old_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_text := NEW.metadata->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_new_source_id := v_text::uuid;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.metadata->>'satellite_id') IS DISTINCT FROM
         (OLD.metadata->>'satellite_id') THEN
    RAISE EXCEPTION 'satellite target rake ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_marker := OLD.terminal_closed_at; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_marker := NEW.terminal_closed_at; END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker
     AND public.fn_ca_terminal_marker_transition_is_exact(
           to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
    RETURN NEW;
  END IF;
  -- A recognized satellite fee row is append-only. Refusing an already-locked
  -- UPDATE/DELETE before any parent lookup removes the child-to-source lock
  -- edge. INSERT locks the target first, then the source, matching the
  -- canonical satellite authority.
  IF TG_OP <> 'INSERT'
     AND COALESCE(v_old_source_id,v_new_source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'satellite target rake rows are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'terminal target tournament cannot gain satellite rake evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM NEW.tournament_id THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
    IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_new_source_id IS NOT NULL
     AND v_new_source_id IS DISTINCT FROM v_old_source_id THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id = v_new_source_id FOR SHARE;
  END IF;
  IF public.fn_ca_has_committed_tournament_receipt(v_old_source_id)
     OR public.fn_ca_has_committed_tournament_receipt(v_new_source_id) THEN
    RAISE EXCEPTION 'completed satellite target rake evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- Installed Body MD5: 6f0c873ffaa7ed73f0936fb681da1a66
CREATE OR REPLACE FUNCTION public.fn_satellite_transfer_ledger_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_ids uuid[] := ARRAY[]::uuid[];
  v_source_id uuid;
  v_target_id uuid;
  v_text text;
  v_row jsonb;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.from_entity_id IS DISTINCT FROM OLD.from_entity_id
       OR NEW.to_entity_id IS DISTINCT FROM OLD.to_entity_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR (NEW.metadata->>'satellite_id') IS DISTINCT FROM
          (OLD.metadata->>'satellite_id')) THEN
    RAISE EXCEPTION 'satellite transfer journal ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_row IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  ] LOOP
    IF v_row IS NULL THEN CONTINUE; END IF;
    v_text := v_row->>'tournament_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    IF v_row->>'from_type' = 'prize_liability' THEN
      v_text := v_row->>'from_entity_id';
      IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_source_ids := array_append(v_source_ids,v_text::uuid);
      END IF;
    END IF;
    v_text := split_part(COALESCE(v_row->>'idempotency_key',''),':',2);
    IF COALESCE(v_row->>'idempotency_key','') LIKE 'tourney:%:seat:%:pool_transfer'
       AND v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
    v_text := v_row->'metadata'->>'satellite_id';
    IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_source_ids := array_append(v_source_ids,v_text::uuid);
    END IF;
  END LOOP;
  IF TG_OP <> 'INSERT' AND cardinality(v_source_ids) > 0 THEN
    RAISE EXCEPTION 'satellite transfer journal is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.to_type = 'prize_liability' THEN
    SELECT t.id INTO v_target_id FROM public.tournaments t
     WHERE t.id = NEW.to_entity_id;
    IF v_target_id IS NOT NULL THEN
      -- The transfer's AFTER trigger writes target escrow, so own the target
      -- before any source root exactly as fn_settle_satellite_tournament does.
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_target_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'terminal target cannot accept a satellite transfer journal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  FOR v_source_id IN
    SELECT DISTINCT source.id FROM unnest(v_source_ids) source(id)
     WHERE source.id IS NOT NULL ORDER BY source.id
  LOOP
    IF TG_OP = 'INSERT' AND v_source_id IS DISTINCT FROM v_target_id THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_status
        FROM public.tournaments t
       WHERE t.id = v_source_id FOR SHARE;
      IF v_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'completed satellite transfer journal is immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_source_id) THEN
      RAISE EXCEPTION 'completed satellite transfer journal is immutable'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- Installed Body MD5: f80eff4c311820670f1b71d15c29452d
CREATE OR REPLACE FUNCTION public.fn_tournament_club_for_user(p_user_id uuid, p_tournament_id uuid, p_preferred_club uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_t_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_t_club
    FROM tournaments t WHERE t.id = p_tournament_id;

  IF v_union IS NULL THEN
    RETURN v_t_club;                       -- standalone club tournament
  END IF;

  /* THE HOST CLUB IS IN ITS OWN UNION (2026-09-10). A tournament hosted BY a
     union has club_id = union_id, and that house club is never a row in
     union_clubs. The membership test below joined union_clubs, so the
     tournament's own club could never be the preferred club - a satellite
     winner who IS a member of the host club was resolved to some other club
     and the ticket award was refused for a club mismatch. Friday Night
     Feature Satellite Heads-Up sat RUNNING for 16 hours on that refusal. The
     host club counts as in the union without needing the row. */
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved')
                   AND (m.club_id = v_t_club
                        OR EXISTS (SELECT 1 FROM union_clubs uc
                                    WHERE uc.club_id = m.club_id AND uc.union_id = v_union)))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Same stable home club a horse uses for cash play, so a horse's tournament
    -- and cash activity always belong to the same club.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');
    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;

-- Installed Body MD5: ba1c6218246bddd37dc68f746df9e5ef
CREATE OR REPLACE FUNCTION public.fn_tournament_late_registration_open(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT t.status='RUNNING'
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND COALESCE(t.current_level,0)>=0
       AND COALESCE(t.late_reg_levels,0)>=0
       AND COALESCE(t.rebuy_levels,0)>=0
       AND COALESCE(t.late_reg_mins,0)>=0
       AND (
         CASE
           WHEN COALESCE(t.late_reg_levels,t.rebuy_levels,0)>0
             THEN COALESCE(t.current_level,0)
                    <COALESCE(t.late_reg_levels,t.rebuy_levels,0)
           WHEN COALESCE(t.late_reg_mins,0)>0
             THEN t.started_at IS NOT NULL
              AND clock_timestamp()
                    <t.started_at+make_interval(mins=>t.late_reg_mins)
           ELSE false
         END
       )
       AND (
         t.max_players IS NULL OR t.max_players<=0 OR (
           SELECT count(*) FROM public.tournament_players tp
            WHERE tp.tournament_id=t.id
         )<t.max_players
       )
      FROM public.tournaments t
     WHERE t.id=p_tournament_id
  ),false);
$function$;

-- Installed Body MD5: ee35755452ea00f700ccd08a7cc77f7e
CREATE OR REPLACE FUNCTION public.trg_seed_bounty_head()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_head numeric;
BEGIN
  -- Already seeded by fn_register_for_tournament / fn_register_horse_for_tournament.
  IF COALESCE(NEW.current_bounty, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = NEW.tournament_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN NEW;
  END IF;

  v_head := round(COALESCE(v_t.bounty_amount, 0), 2);
  IF v_head <= 0 THEN RETURN NEW; END IF;

  -- EVERY bounty format, mystery included, puts the FLAT bounty on the head.
  -- The mystery value is drawn from the funded chest inventory at the knockout
  -- (fn_mystery_bounty_reserve), not from a PRNG at the till. mystery_bounty_value
  -- is deliberately left alone here: it is set by the reveal, from the chest.
  UPDATE tournament_players
     SET current_bounty = v_head
   WHERE id = NEW.id;

  -- Fund the pool by this entrant's bounty contribution.
  UPDATE tournaments
     SET bounty_pool = round(COALESCE(bounty_pool, 0) + v_head, 2)
   WHERE id = NEW.tournament_id;

  /**
   * REACHING THIS LINE MEANS NOBODY PAID FOR THIS HEAD (2026-08-29).
   *
   * The early return above catches every entrant who arrived through a
   * register RPC, because those pre-set the head from the collected buy-in
   * split. So the pool was just increased by an entrant with no recorded
   * contribution -- a satellite seat award, a ticket redemption, a backfill,
   * or a path that does not exist yet.
   *
   * Not blocked: see the migration header. Made loud, once per tournament, so
   * the question can be answered from evidence instead of assumption.
   */
  INSERT INTO financial_alerts (severity, source, message, context)
  SELECT 'warning', 'trg_seed_bounty_head',
         'Bounty pool funded for an entrant with no collected buy-in split',
         jsonb_build_object(
           'tournament_id', NEW.tournament_id,
           'head', v_head,
           'detail', 'this entrant did not arrive through a register RPC, so no bounty '
                  || 'contribution was collected for the head just added to bounty_pool; '
                  || 'fn_finalize_bounty_pool pays any unclaimed remainder to the champion')
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_alerts
      WHERE source = 'trg_seed_bounty_head'
        AND resolved IS NOT TRUE
        AND context->>'tournament_id' = NEW.tournament_id::text);

  RETURN NEW;
END;
$function$;

-- Installed Body MD5: 7043d39510db7db89173bc98d47a5ce1
CREATE OR REPLACE FUNCTION public.fn_ca_has_committed_tournament_receipt(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    SELECT (upper(COALESCE(t.status::text,'')) = 'COMPLETED'
       AND (EXISTS (
              SELECT 1 FROM public.tournament_terminal_settlements h
               WHERE h.tournament_id = t.id)
         OR EXISTS (
              SELECT 1 FROM public.tournament_satellite_settlements h
               WHERE h.tournament_id = t.id)))
       OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
       AND EXISTS (
              SELECT 1 FROM public.tournament_cancellation_receipts h
               WHERE h.tournament_id = t.id))
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
  ),false)
$function$;

-- Installed Body MD5: 3c9ce32b45c11b7372654c6efa89f667
CREATE OR REPLACE FUNCTION public.fn_ca_terminal_marker_transition_is_exact(p_old jsonb, p_new jsonb, p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    p_old ? 'terminal_closed_at'
    AND p_new ? 'terminal_closed_at'
    AND NULLIF(p_old->>'terminal_closed_at','') IS NULL
    AND NULLIF(p_new->>'terminal_closed_at','') IS NOT NULL
    AND (p_new - 'terminal_closed_at') IS NOT DISTINCT FROM
        (p_old - 'terminal_closed_at')
    AND EXISTS (
      SELECT 1
        FROM public.tournaments t
       WHERE t.id = p_tournament_id
         AND upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
         AND t.ended_at IS NOT NULL
         AND isfinite(t.ended_at)
         AND NULLIF(p_new->>'terminal_closed_at','')::timestamptz
               IS NOT DISTINCT FROM t.ended_at
    ),false)
$function$;

-- Installed Body MD5: ecb120c2c6a4ecee6c2e04d4c9b5ebc7
CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
DROP TRIGGER trg_sync_tournament_current_players ON public.tournament_players;
CREATE TRIGGER satellite_transfer_ledger_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_satellite_transfer_ledger_is_immutable();
CREATE TRIGGER zz_ca_escrow_seat_transfer_leg AFTER INSERT ON chip_ledger FOR EACH ROW WHEN (new.to_type = 'prize_liability'::text AND new.idempotency_key ~~ 'tourney:%:seat:%:pool_transfer'::text) EXECUTE FUNCTION fn_ca_escrow_on_seat_transfer_leg();
CREATE TRIGGER satellite_target_rake_is_immutable BEFORE INSERT OR DELETE OR UPDATE ON rake_records FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_rake_is_immutable();
CREATE TRIGGER zz_ca_escrow_seat_payout AFTER INSERT ON tournament_payouts FOR EACH ROW WHEN (new.source = 'satellite_seat'::text) EXECUTE FUNCTION fn_ca_escrow_on_seat_payout();
CREATE TRIGGER satellite_target_player_provenance_is_immutable BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, user_id, is_satellite_qualifier, source_satellite_id ON tournament_players FOR EACH ROW EXECUTE FUNCTION fn_satellite_target_player_provenance_is_immutable();
CREATE TRIGGER seed_bounty_head AFTER INSERT ON tournament_players FOR EACH ROW EXECUTE FUNCTION trg_seed_bounty_head();
CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT OR DELETE OR UPDATE OF status, tournament_id ON tournament_players FOR EACH ROW EXECUTE FUNCTION fn_sync_tournament_current_players();
