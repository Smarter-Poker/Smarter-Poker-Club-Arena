-- 20260829d_relink_backfills_rake_attributions.sql
-- APPLIED TO PRODUCTION 2026-08-29 ~16:05 UTC via Supabase MCP
-- (migration name: relink_backfills_rake_attributions).
--
-- Late-linked hands must still get their per-player rake ledger.
--
-- Under load the engine can bank a hand's rake with hand_id NULL (the
-- hand_history insert timed out; the retry queue writes the hand row later
-- and calls fn_relink_rake_record_to_hand). atomic_distribute_rake correctly
-- skips the rake_attributions insert for a null hand id — but the relink then
-- restored hand_id WITHOUT the ledger, so a relinked weighted hand tripped
-- fn_rake_attribution_drift. THE WATCHDOG WORKED: 6 hands caught on
-- 2026-08-29 (clusters at 15:16 and 15:48 UTC), a critical
-- RAKE_ALLOCATION_MISMATCH financial_alert filed at 15:29. This closes the
-- gap at the source and repairs what it produced.
--
--   1. fn_backfill_rake_attributions(p_since): idempotent, method-aware
--      repair — writes any missing per-player ledger rows (incl. BBJ
--      attribution) from the data rake_records already holds.
--   2. fn_relink_rake_record_to_hand v2: after restoring hand_id it now also
--      writes the ledger, exactly as atomic_distribute_rake would have.
--   3. One-shot repair of everything since the ledger went live, then an
--      ASSERT that fn_rake_attribution_drift reads clean — the migration
--      aborts rather than claim a fix it cannot prove.
--
-- See the applied migration body in the Supabase migration history; this file
-- records it in the repo for CHECK 17 and for the next reader. Functions
-- declared: fn_backfill_rake_attributions (service_role only),
-- fn_relink_rake_record_to_hand (replaced in place, same signature).

CREATE OR REPLACE FUNCTION public.fn_backfill_rake_attributions(p_since timestamptz DEFAULT now() - interval '7 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows integer := 0;
BEGIN
  INSERT INTO public.rake_attributions (
    hand_id, player_id, rake_amount, rake_record_id, table_id, club_id,
    gross_contribution, returned_uncalled, eligible_contribution,
    contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
    rake_method
  )
  SELECT r.hand_id, a.user_id, a.credit, r.id, r.table_id, r.club_id,
         (r.player_contributions ->> a.user_id::text)::numeric
           + COALESCE((r.returned_uncalled ->> a.user_id::text)::numeric, 0),
         COALESCE((r.returned_uncalled ->> a.user_id::text)::numeric, 0),
         (r.player_contributions ->> a.user_id::text)::numeric,
         a.weight, a.credit, COALESCE(b.credit, 0),
         COALESCE(r.rake_method, 'DEALT_EQUAL')
    FROM public.rake_records r
    CROSS JOIN LATERAL public.fn_allocate_rake_credits(
      r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')) a
    LEFT JOIN LATERAL public.fn_allocate_rake_credits(
      COALESCE(r.bbj_contribution, 0), r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')) b
      ON b.user_id = a.user_id
   WHERE r.hand_id IS NOT NULL
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND jsonb_typeof(r.player_contributions) = 'object'
     AND r.created_at >= p_since
     AND NOT EXISTS (SELECT 1 FROM public.rake_attributions ra WHERE ra.hand_id = r.hand_id)
  ON CONFLICT (hand_id, player_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $function$;

REVOKE ALL ON FUNCTION public.fn_backfill_rake_attributions(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backfill_rake_attributions(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_relink_rake_record_to_hand(p_table_id uuid, p_hand_number bigint, p_hand_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_linked int;
  v_row record;
begin
  if p_table_id is null or p_hand_number is null or p_hand_id is null then
    return 0;
  end if;

  -- uq_rake_records_hand_id is UNIQUE on hand_id WHERE hand_id IS NOT NULL, so
  -- refuse rather than error if this hand id is already attached somewhere.
  if exists (select 1 from public.rake_records where hand_id = p_hand_id) then
    return 0;
  end if;

  update public.rake_records r
     set hand_id = p_hand_id
   where r.id = (
           select id
             from public.rake_records
            where table_id = p_table_id
              and hand_id is null
              and metadata->>'hand_number' = p_hand_number::text
            order by created_at, id
            limit 1
            for update skip locked
         )
     and r.hand_id is null
  returning r.* into v_row;

  get diagnostics v_linked = row_count;

  -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): a null-hand banking skipped the
  -- per-player ledger (it keys on hand_id). Now that the hand id exists,
  -- write the ledger the same way atomic_distribute_rake would have.
  if v_linked > 0 and v_row.rake_amount > 0
     and v_row.player_contributions is not null
     and jsonb_typeof(v_row.player_contributions) = 'object' then
    insert into public.rake_attributions (
      hand_id, player_id, rake_amount, rake_record_id, table_id, club_id,
      gross_contribution, returned_uncalled, eligible_contribution,
      contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
      rake_method
    )
    select p_hand_id, a.user_id, a.credit, v_row.id, v_row.table_id, v_row.club_id,
           (v_row.player_contributions ->> a.user_id::text)::numeric
             + coalesce((v_row.returned_uncalled ->> a.user_id::text)::numeric, 0),
           coalesce((v_row.returned_uncalled ->> a.user_id::text)::numeric, 0),
           (v_row.player_contributions ->> a.user_id::text)::numeric,
           a.weight, a.credit, coalesce(b.credit, 0),
           coalesce(v_row.rake_method, 'DEALT_EQUAL')
      from public.fn_allocate_rake_credits(
             v_row.rake_amount, v_row.player_contributions,
             coalesce(v_row.rake_method, 'DEALT_EQUAL')) a
      left join public.fn_allocate_rake_credits(
             coalesce(v_row.bbj_contribution, 0), v_row.player_contributions,
             coalesce(v_row.rake_method, 'DEALT_EQUAL')) b
        on b.user_id = a.user_id
    on conflict (hand_id, player_id) do nothing;
  end if;

  return v_linked;
end;
$function$;

-- Engine-only surface (the hand-history retry queue calls it with the service
-- role); no browser has any business relinking rake rows. PUBLIC named
-- alongside the roles deliberately (check-definer-authorization).
REVOKE ALL ON FUNCTION public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) TO service_role;

-- One-shot repair + proof (ledger went live 2026-08-29 ~13:26 UTC).
DO $$
DECLARE v_backfilled int; v_drift int;
BEGIN
  v_backfilled := public.fn_backfill_rake_attributions('2026-08-29 13:00+00'::timestamptz);
  SELECT count(*) INTO v_drift FROM public.fn_rake_attribution_drift(6);
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'backfill left % weighted hand(s) still drifting', v_drift;
  END IF;
  RAISE NOTICE 'backfilled % attribution row(s); drift now clean', v_backfilled;
END $$;
