-- Test-only helpers: one assertion, and the smallest amount of hand evidence
-- the cleanup can see - a table, a hand's hole cards at a chosen age, and the
-- F06 permit that says whether that hand's transition has resolved.
\set ON_ERROR_STOP on
CREATE SCHEMA probe;

CREATE FUNCTION probe.check(p_ok boolean, p_what text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'PROBE FAILED: %', p_what;
  END IF;
END;
$$;

CREATE FUNCTION probe.table_of(p_seed text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid := md5('table:' || p_seed)::uuid;
BEGIN
  INSERT INTO public.tables (id, tournament_id) VALUES (v, md5('event:' || p_seed)::uuid)
  ON CONFLICT (id) DO NOTHING;
  RETURN v;
END;
$$;

-- p_seats hole-card rows for one hand, dealt p_age ago.
CREATE FUNCTION probe.deal(p_table uuid, p_hand bigint, p_age interval, p_seats integer DEFAULT 2)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.table_hole_cards (table_id, hand_number, user_id, seat_number, cards, created_at)
  SELECT p_table, p_hand, md5('u:' || p_table::text || ':' || p_hand || ':' || s)::uuid, s,
         jsonb_build_array('Ah', 'Kd'), now() - p_age
  FROM generate_series(1, p_seats) s;
$$;

-- The hand's F06 permit, in the state given.
CREATE FUNCTION probe.permit(p_table uuid, p_hand bigint, p_state text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO smarter_private.f06_hand_permits
    (permit_id, tournament_id, table_id, lifecycle, hand_number, custody_id, generation, state, evidence_id)
  SELECT md5('permit:' || p_table::text || ':' || p_hand)::uuid,
         t.tournament_id, p_table, 1, p_hand,
         md5('custody:' || p_table::text)::uuid, md5('gen:' || p_table::text)::uuid,
         p_state,
         CASE WHEN p_state = 'reserved' THEN NULL
              ELSE md5('receipt:' || p_table::text || ':' || p_hand)::uuid END
  FROM public.tables t WHERE t.id = p_table
  ON CONFLICT (table_id, hand_number) DO UPDATE
     SET state = EXCLUDED.state, evidence_id = EXCLUDED.evidence_id;
$$;

CREATE FUNCTION probe.cards(p_table uuid, p_hand bigint) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM public.table_hole_cards
   WHERE table_id = p_table AND hand_number = p_hand;
$$;

-- The cron job's call, exactly as job 9 makes it (username postgres).
CREATE FUNCTION probe.cleanup() RETURNS void
LANGUAGE sql AS $$ SELECT public.cleanup_old_hole_cards() $$;

-- Prints one machine-readable census line per assertion point.
CREATE FUNCTION probe.census(p_label text, p_before bigint, p_after bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'CENSUS % before=% after=%', p_label, p_before, p_after;
END;
$$;
