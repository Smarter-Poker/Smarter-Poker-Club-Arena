-- Test-only helpers: one assertion, and the smallest amount of hand evidence
-- the prune can see - a tournament table, one completed hand written across
-- all four tables the prune deletes from, and the F06 permit that says whether
-- that hand's transition has resolved.
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

-- A non-Spin MTT table, so the existing Spin/classification gate admits it.
CREATE FUNCTION probe.table_of(p_seed text, p_variant text DEFAULT 'nlh',
                               p_type text DEFAULT 'MTT', p_status text DEFAULT 'RUNNING')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := md5('table:' || p_seed)::uuid;
        e uuid := md5('event:' || p_seed)::uuid;
BEGIN
  INSERT INTO public.tournaments (id, status, tournament_type, variant)
  VALUES (e, p_status, p_type, p_variant) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.tables (id, tournament_id) VALUES (v, e) ON CONFLICT (id) DO NOTHING;
  RETURN v;
END;
$$;

-- A horse-only profile, so the prune classifies the hand as is_human=false and
-- therefore doomed. A hand with any non-horse seat is kept by the existing
-- classification and never reaches the DELETEs at all.
CREATE FUNCTION probe.horse(p_seed text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v uuid := md5('horse:' || p_seed)::uuid;
BEGIN
  INSERT INTO public.profiles (id, is_horse) VALUES (v, true) ON CONFLICT (id) DO NOTHING;
  RETURN v;
END;
$$;

-- One completed hand, written into every table the prune deletes from:
-- hand_history (keyed id), hand_atomic_commits (keyed hand_id, and carrying
-- its own table_id/hand_number), rake_attributions (keyed hand_id) and
-- ca_hand_player_idx (keyed hand_id). p_human seats a non-horse player.
CREATE FUNCTION probe.hand(p_table uuid, p_hand bigint, p_age interval,
                           p_human boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := md5('hand:' || p_table::text || ':' || p_hand)::uuid;
        v_a uuid := probe.horse(p_table::text || ':a');
        v_b uuid;
        v_when timestamptz := now() - p_age;
BEGIN
  IF p_human THEN
    v_b := md5('human:' || p_table::text)::uuid;
    INSERT INTO public.profiles (id, is_horse) VALUES (v_b, false) ON CONFLICT (id) DO NOTHING;
  ELSE
    v_b := probe.horse(p_table::text || ':b');
  END IF;

  INSERT INTO public.hand_history (id, table_id, tournament_id, hand_number, players, created_at)
  SELECT v_id, p_table, t.tournament_id, p_hand::integer,
         jsonb_build_array(jsonb_build_object('userId', v_a::text),
                           jsonb_build_object('userId', v_b::text)),
         v_when
    FROM public.tables t WHERE t.id = p_table;

  INSERT INTO public.hand_atomic_commits (table_id, hand_number, hand_id, created_at)
  VALUES (p_table, p_hand, v_id, v_when);

  INSERT INTO public.rake_attributions (hand_id, table_id, player_id, created_at)
  VALUES (v_id, p_table, v_a, v_when), (v_id, p_table, v_b, v_when);

  INSERT INTO public.ca_hand_player_idx (user_id, hand_id, created_at)
  VALUES (v_a, v_id, v_when), (v_b, v_id, v_when);

  RETURN v_id;
END;
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

-- Row counts for one hand, per table the prune deletes from.
CREATE FUNCTION probe.hh(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.hand_history WHERE id = p_id $$;
CREATE FUNCTION probe.hac(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.hand_atomic_commits WHERE hand_id = p_id $$;
CREATE FUNCTION probe.rake(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.rake_attributions WHERE hand_id = p_id $$;
CREATE FUNCTION probe.idx(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.ca_hand_player_idx WHERE hand_id = p_id $$;
-- All four at once: 1+1+2+2 = 6 rows for a hand probe.hand() wrote.
CREATE FUNCTION probe.rows(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT probe.hh(p_id) + probe.hac(p_id) + probe.rake(p_id) + probe.idx(p_id) $$;
CREATE FUNCTION probe.human_flag(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(has_human::text, 'null') FROM public.hand_history WHERE id = p_id $$;

-- The cron job's call, exactly as job 117 makes it (username postgres).
CREATE FUNCTION probe.prune() RETURNS integer
LANGUAGE sql AS $$ SELECT public.sp_prune_hand_history(5000) $$;

-- Prints one machine-readable census line per assertion point.
CREATE FUNCTION probe.census(p_label text, p_before bigint, p_after bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'CENSUS % before=% after=%', p_label, p_before, p_after;
END;
$$;
