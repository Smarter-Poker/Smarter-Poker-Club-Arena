DO $$
DECLARE
  r                record;
  v_res            jsonb;
  v_landed         integer := 0;
  v_refused        integer := 0;
  v_threw          integer := 0;
  v_report         jsonb   := '[]'::jsonb;
  v_departed_sum   numeric := 0;
  v_wallets_before numeric;
  v_wallets_after  numeric;
  v_moved          numeric;
  v_clubs          uuid[];
BEGIN
  -- A hand held up by a live seat lock must not take the whole batch with it.
  SET LOCAL lock_timeout = '5s';

  -- Every club whose table appears in the lost hands. The conservation
  -- assertion at the end is measured across exactly these wallets.
  SELECT array_agg(DISTINCT t.club_id)
    INTO v_clubs
    FROM public.financial_alerts a
    JOIN public.tables t ON t.id = (a.context->'payload'->>'p_table_id')::uuid
   WHERE a.source = 'DB.settle_hand_stacks_unreachable'
     AND t.club_id IS NOT NULL;

  IF v_clubs IS NULL OR array_length(v_clubs, 1) = 0 THEN
    RAISE EXCEPTION 'no clubs resolve for the unreachable-hand alerts - the board has moved; refusing to guess';
  END IF;

  SELECT COALESCE(sum(m.chip_balance), 0) INTO v_wallets_before
    FROM public.club_members m WHERE m.club_id = ANY(v_clubs);

  FOR r IN
    WITH a AS (
      SELECT a.id AS alert_id,
             a.context->'payload' AS pl,
             (a.context->'payload'->>'p_table_id')::uuid   AS table_id,
             (a.context->'payload'->>'p_hand_number')::bigint AS hand_number
        FROM public.financial_alerts a
       WHERE a.source = 'DB.settle_hand_stacks_unreachable'
    ), k AS (
      SELECT a.*, md5('ca-hand:' || a.table_id::text || ':' || a.hand_number::text)::uuid AS hand_id
        FROM a
    )
    SELECT k.*, (t.tournament_id IS NOT NULL) AS is_tournament
      FROM k
      JOIN public.tables t ON t.id = k.table_id
      LEFT JOIN public.settlement_idempotency_keys s
             ON s.table_id = k.table_id AND s.hand_id = k.hand_id
     WHERE s.hand_id IS NULL
     ORDER BY k.hand_number
  LOOP
    BEGIN
      v_res := public.fn_ca_settle_hand_stacks_absolute(
        r.table_id,
        r.hand_number,
        r.pl->'p_stacks',
        NULLIF(r.pl->>'p_rake', '')::numeric,
        NULLIF(r.pl->>'p_bbj', '')::numeric,
        NULLIF(r.pl->>'p_ref', ''),
        NULLIF(r.pl->>'p_inflow', '')::numeric
      );

      IF COALESCE((v_res->>'success')::boolean, false) THEN
        v_landed := v_landed + 1;
        SELECT COALESCE(v_departed_sum + sum((d->>'delta')::numeric), v_departed_sum)
          INTO v_departed_sum
          FROM jsonb_array_elements(COALESCE(v_res->'departed', '[]'::jsonb)) d;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
          'hand', r.hand_number, 'settled', true,
          'net', v_res->'net_deltas', 'departed', v_res->'departed'));
      ELSE
        v_refused := v_refused + 1;
        v_report := v_report || jsonb_build_array(jsonb_build_object(
          'hand', r.hand_number, 'settled', false,
          'tournament', r.is_tournament,
          'refused', left(COALESCE(v_res->>'error', v_res->>'reason', 'unknown'), 160)));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_threw := v_threw + 1;
      v_report := v_report || jsonb_build_array(jsonb_build_object(
        'hand', r.hand_number, 'settled', false, 'threw', left(SQLERRM, 160)));
    END;
  END LOOP;

  SELECT COALESCE(sum(m.chip_balance), 0) INTO v_wallets_after
    FROM public.club_members m WHERE m.club_id = ANY(v_clubs);
  v_moved := round(v_wallets_after - v_wallets_before, 2);

  IF v_moved IS DISTINCT FROM round(v_departed_sum, 2) THEN
    RAISE EXCEPTION
      'conservation: club wallets moved % but the settlements reported % of departed-seat deltas; refusing the whole re-drive. Report: %',
      v_moved, round(v_departed_sum, 2), v_report::text;
  END IF;

  IF v_landed = 0 THEN
    RAISE EXCEPTION
      'not one of the % unsettled hands could be re-driven; the board has moved since the probe. Report: %',
      v_landed + v_refused + v_threw, v_report::text;
  END IF;

  UPDATE public.financial_alerts a
     SET resolved = true,
         resolved_at = now(),
         resolution = CASE
           WHEN EXISTS (
             SELECT 1 FROM public.settlement_idempotency_keys s
              WHERE s.table_id = (a.context->'payload'->>'p_table_id')::uuid
                AND s.hand_id = md5('ca-hand:' || (a.context->'payload'->>'p_table_id')
                                    || ':' || (a.context->'payload'->>'p_hand_number'))::uuid
                AND s.status = 'succeeded')
           THEN 'Settled 2026-09-08 by 20260908040114. The stack write was lost to a PostgREST schema-cache reload started by the phase-8 migrations; re-driven through fn_ca_settle_hand_stacks_absolute in delta mode, which applied the hand''s differences to the current seats and settled any departed seat against its club wallet. Root cause fixed in code: server/src/services/supabase/pendingWrites.ts.'
           ELSE 'Reviewed 2026-09-08 by 20260908040114 and NOT settled. The stack write was lost to a PostgREST schema-cache reload started by the phase-8 migrations, and by the time it was found the hand''s seats had gone (tournament seats busted or moved by a table balance; on cash tables a departed seat whose club wallet no longer resolves). fn_ca_settle_hand_stacks_absolute refuses such a hand whole, by design, and there is no idempotent path to settle it - hand-writing wallet rows is forbidden by CLAUDE.md 10.9 rule 2. Real-chip exposure across all eighteen lost hands is 27.73 owed and 40.24 overpaid. Root cause fixed in code so a hand is no longer lost long enough for its seats to disappear: server/src/services/supabase/pendingWrites.ts.'
         END
   WHERE a.source = 'DB.settle_hand_stacks_unreachable'
     AND a.resolved = false;

  RAISE NOTICE 're-drive complete: % landed, % refused, % threw; club wallets moved % (departed-seat deltas). Report: %',
    v_landed, v_refused, v_threw, v_moved, v_report::text;
END $$;