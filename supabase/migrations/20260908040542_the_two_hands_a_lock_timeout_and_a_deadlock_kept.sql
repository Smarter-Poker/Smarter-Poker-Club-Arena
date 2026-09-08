DO $$
/* ==========================================================================
   The two hands a lock timeout and a deadlock kept
   ==========================================================================

   2026-09-08, immediately after 20260908040302, which re-drove the eighteen
   hands a PostgREST schema-cache reload dropped during the phase-8 migrations.
   Sixteen of those eighteen ended correctly: four settled, and twelve were
   refused whole by fn_ca_settle_hand_stacks_absolute because their seats are
   gone - the platform protecting itself, exactly as designed.

   TWO DID NOT END AT ALL. 7903228 hit `canceling statement due to lock timeout`
   and 7903411 hit `deadlock detected`. Neither is the database's verdict on the
   hand; both are this batch colliding with live play. Re-driving eighteen hands
   across eighteen tables in ONE transaction accumulates row locks on every
   named seat and holds them to the end, in an order the engine knows nothing
   about - which is the same mistake, in the same shape, that the phase-8
   migration made at 02:19 and had to be split to avoid.

   So this retries only those two, and only those two: the WHERE clause below
   asks for hands whose recorded error is transient, so a hand the database
   genuinely refused can never be swept in by re-running this.

   Money at stake, read from the payloads: 7903228 owes 626120fa 4.85 and takes
   3.00 from 2936c42b; 7903411 owes 2e49e7e8 7.60 and takes 1.00 from ef58b642
   and 9.00 from 8ecf28ab. Both are departed-seat settlements through the RPC's
   own idempotency-keyed path (CLAUDE.md 10.9 rule 2), and both payloads
   conserve exactly: sum(delta) = -(rake + bbj).

   The conservation assertion is the same one, and it aborts the whole thing if
   the wallets moved by anything other than the deltas the settlements report.
   ========================================================================== */
DECLARE
  r              record;
  v_res          jsonb;
  v_landed       integer := 0;
  v_report       jsonb   := '[]'::jsonb;
  v_departed_sum numeric := 0;
  v_before       numeric;
  v_after        numeric;
  v_moved        numeric;
  v_clubs        uuid[];
BEGIN
  /* Longer than the 5s that timed out, because there are two hands here rather
     than eighteen and the lock set is correspondingly small. */
  SET LOCAL lock_timeout = '20s';

  SELECT array_agg(DISTINCT t.club_id)
    INTO v_clubs
    FROM public.financial_alerts a
    JOIN public.tables t ON t.id = (a.context->'payload'->>'p_table_id')::uuid
   WHERE a.source = 'DB.settle_hand_stacks_unreachable'
     AND t.club_id IS NOT NULL;

  SELECT COALESCE(sum(m.chip_balance), 0) INTO v_before
    FROM public.club_members m WHERE m.club_id = ANY(v_clubs);

  FOR r IN
    WITH a AS (
      SELECT a.context->'payload' AS pl,
             (a.context->'payload'->>'p_table_id')::uuid     AS table_id,
             (a.context->'payload'->>'p_hand_number')::bigint AS hand_number
        FROM public.financial_alerts a
       WHERE a.source = 'DB.settle_hand_stacks_unreachable'
    ), k AS (
      SELECT a.*, md5('ca-hand:' || a.table_id::text || ':' || a.hand_number::text)::uuid AS hand_id
        FROM a
    )
    SELECT k.*
      FROM k
      JOIN public.settlement_idempotency_keys s
             ON s.table_id = k.table_id AND s.hand_id = k.hand_id
     WHERE s.status <> 'succeeded'
       AND (s.error ILIKE '%lock timeout%'
         OR s.error ILIKE '%deadlock%'
         OR s.error ILIKE '%could not serialize%')
     ORDER BY k.hand_number
  LOOP
    v_res := public.fn_ca_settle_hand_stacks_absolute(
      r.table_id, r.hand_number, r.pl->'p_stacks',
      NULLIF(r.pl->>'p_rake', '')::numeric,
      NULLIF(r.pl->>'p_bbj', '')::numeric,
      NULLIF(r.pl->>'p_ref', ''),
      NULLIF(r.pl->>'p_inflow', '')::numeric);

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_landed := v_landed + 1;
      SELECT COALESCE(v_departed_sum + sum((d->>'delta')::numeric), v_departed_sum)
        INTO v_departed_sum
        FROM jsonb_array_elements(COALESCE(v_res->'departed', '[]'::jsonb)) d;
    END IF;
    v_report := v_report || jsonb_build_array(jsonb_build_object(
      'hand', r.hand_number, 'ok', v_res->'success',
      'net', v_res->'net_deltas', 'departed', v_res->'departed',
      'err', left(COALESCE(v_res->>'error', ''), 140)));
  END LOOP;

  SELECT COALESCE(sum(m.chip_balance), 0) INTO v_after
    FROM public.club_members m WHERE m.club_id = ANY(v_clubs);
  v_moved := round(v_after - v_before, 2);

  IF v_moved IS DISTINCT FROM round(v_departed_sum, 2) THEN
    RAISE EXCEPTION
      'conservation: club wallets moved % but the settlements reported %; refusing. Report: %',
      v_moved, round(v_departed_sum, 2), v_report::text;
  END IF;

  /* Any hand that settled now carries the settled note rather than the
     reviewed-and-not-settled one written minutes ago. */
  UPDATE public.financial_alerts a
     SET resolution = 'Settled 2026-09-08 by the retry migration after a lock timeout / deadlock in the first pass. The stack write was lost to a PostgREST schema-cache reload started by the phase-8 migrations; re-driven through fn_ca_settle_hand_stacks_absolute in delta mode. Root cause fixed in code: server/src/services/supabase/pendingWrites.ts.'
   WHERE a.source = 'DB.settle_hand_stacks_unreachable'
     AND EXISTS (
       SELECT 1 FROM public.settlement_idempotency_keys s
        WHERE s.table_id = (a.context->'payload'->>'p_table_id')::uuid
          AND s.hand_id = md5('ca-hand:' || (a.context->'payload'->>'p_table_id')
                              || ':' || (a.context->'payload'->>'p_hand_number'))::uuid
          AND s.status = 'succeeded')
     AND a.resolution NOT LIKE 'Settled%';

  RAISE NOTICE 'retry complete: % landed; wallets moved %. Report: %', v_landed, v_moved, v_report::text;
END $$;