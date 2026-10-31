-- 20261028100820_lightning_accepted_rosters_bind_original_hand_seats.sql
-- Reserved by scripts/new-migration.mjs. Phase 1 live verification found
-- every accepted Lightning roster unavailable: physical anchor chairs are
-- not the hand's positions. Bind each already-locked exact anchor generation
-- to the current transaction's settlement marker and immutable hand-player
-- formation seat. A missing, contradictory or partial binding stays unknown.
-- No money, histories, original receipts, caller signatures or replay change.
-- No historical row is rewritten. This is function-only DDL; no hot-table lock.
-- @live-proof: (SELECT md5(pg_get_functiondef('smarter_private.accepted_hand_roster_build(uuid,bigint,uuid,jsonb,boolean,jsonb,timestamptz)'::regprocedure))='ecf42ffc004dfe0d9040e76dd338694e')
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $repair$
DECLARE
  sig constant text := 'smarter_private.accepted_hand_roster_build(uuid,bigint,uuid,jsonb,boolean,jsonb,timestamptz)';
  d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
   WHERE p.oid=sig::regprocedure AND md5(pg_get_functiondef(p.oid))='1ece582b0e0e8fbfafa7fb8a3db30441'
     AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.provolatile='s'
     AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
     AND p.proacl::text='{postgres=X/postgres}';
  IF d IS NULL THEN RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_PREIMAGE_DRIFT'; END IF;
  IF (length(d)-length(replace(d,$old$    IF COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb THEN
      -- Anchor chairs belong to several physical tables; their seat numbers
      -- are not one table's positions, so the capsule cannot state them.
      v_reasons := v_reasons || 'lightning_seat_positions_unbound'::text;
    END IF;
$old$,'')))/length($old$    IF COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb THEN
      -- Anchor chairs belong to several physical tables; their seat numbers
      -- are not one table's positions, so the capsule cannot state them.
      v_reasons := v_reasons || 'lightning_seat_positions_unbound'::text;
    END IF;
$old$) <> 1 THEN RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_ANCHOR_DRIFT'; END IF;
  d:=replace(d,$old$    IF COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb THEN
      -- Anchor chairs belong to several physical tables; their seat numbers
      -- are not one table's positions, so the capsule cannot state them.
      v_reasons := v_reasons || 'lightning_seat_positions_unbound'::text;
    END IF;
$old$,$new$    IF COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb AND
       (jsonb_typeof(p_lightning_seats) IS DISTINCT FROM 'object' OR
        (SELECT count(*) FROM jsonb_object_keys(p_lightning_seats))
          IS DISTINCT FROM jsonb_array_length(p_stacks) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                 WHERE NOT (p_lightning_seats ? (x->>'user_id')))) THEN
      v_reasons := v_reasons || 'lightning_seat_positions_unbound'::text;
    END IF;
$new$);
  IF (length(d)-length(replace(d,$old$               ts.id AS row_id, ts.seat_number,
               p.id AS profile_id, p.is_horse$old$,'')))/length($old$               ts.id AS row_id, ts.seat_number,
               p.id AS profile_id, p.is_horse$old$) <> 1 THEN RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_ANCHOR_DRIFT'; END IF;
  d:=replace(d,$old$               ts.id AS row_id, ts.seat_number,
               p.id AS profile_id, p.is_horse$old$,$new$               ts.id AS row_id,
               CASE WHEN COALESCE(p_lightning_seats, '{}'::jsonb) = '{}'::jsonb
                    THEN ts.seat_number ELSE original_hand.seat END AS seat_number,
               p.id AS profile_id, p.is_horse$new$);
  IF (length(d)-length(replace(d,$old$           AND ts.joined_at = s.joined_at AND ts.table_id = p_table_id
          LEFT JOIN public.profiles p ON p.id = s.user_id$old$,'')))/length($old$           AND ts.joined_at = s.joined_at AND ts.table_id = p_table_id
          LEFT JOIN public.profiles p ON p.id = s.user_id$old$) <> 1 THEN RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_ANCHOR_DRIFT'; END IF;
  d:=replace(d,$old$           AND ts.joined_at = s.joined_at AND ts.table_id = p_table_id
          LEFT JOIN public.profiles p ON p.id = s.user_id$old$,$new$           AND ts.joined_at = s.joined_at
           AND ts.table_id = COALESCE((p_lightning_seats->>s.user_id::text)::uuid, p_table_id)
          -- The marker was written by this settlement transaction while it
          -- locked the exact anchor. Hand position comes from the immutable
          -- formation roster, never the anchor's unrelated physical chair.
          LEFT JOIN LATERAL (
            SELECT min(hp.seat) AS seat
              FROM public.lightning_settlement_marker m
              JOIN public.lightning_hand h ON h.hand_id = m.hand_id
               AND h.host_table_id = p_table_id AND h.hand_number = p_hand_number
              JOIN public.lightning_hand_player hp
                ON hp.hand_id = m.hand_id AND hp.player_id = s.user_id
             WHERE COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb
               AND m.txid = pg_current_xact_id_if_assigned()
               AND m.host_table_id = p_table_id AND m.hand_number = p_hand_number
               AND m.player_id = s.user_id AND m.seat_id = s.seat_id
               AND m.anchor_table_id = ts.table_id
               AND (h.hand_history_id IS NULL OR h.hand_history_id = p_hand_id)
               AND EXISTS (SELECT 1 FROM public.hand_history hh
                            WHERE hh.id = p_hand_id AND hh.table_id = p_table_id
                              AND hh.hand_number = p_hand_number)
            HAVING count(*) = 1
          ) original_hand ON true
          LEFT JOIN public.profiles p ON p.id = s.user_id$new$);
  IF (length(d)-length(replace(d,$old$          CASE WHEN bool_or(j.row_id IS NULL) THEN 'seat_generation_row_missing' END,$old$,'')))/length($old$          CASE WHEN bool_or(j.row_id IS NULL) THEN 'seat_generation_row_missing' END,$old$) <> 1 THEN RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_ANCHOR_DRIFT'; END IF;
  d:=replace(d,$old$          CASE WHEN bool_or(j.row_id IS NULL) THEN 'seat_generation_row_missing' END,$old$,$new$          CASE WHEN bool_or(j.row_id IS NULL) THEN 'seat_generation_row_missing' END,
          CASE WHEN COALESCE(p_lightning_seats, '{}'::jsonb) <> '{}'::jsonb
                 AND bool_or(j.seat_number IS NULL) THEN 'lightning_seat_positions_unbound' END,$new$);
  EXECUTE d;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=sig::regprocedure
      AND md5(pg_get_functiondef(p.oid))='ecf42ffc004dfe0d9040e76dd338694e'
      AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.provolatile='s'
      AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
      AND p.proacl::text='{postgres=X/postgres}') THEN
    RAISE EXCEPTION 'LIGHTNING_ACCEPTED_ROSTER_POSTIMAGE_DRIFT';
  END IF;
END $repair$;
COMMIT;
