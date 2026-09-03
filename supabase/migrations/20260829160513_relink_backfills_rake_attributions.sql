-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829160513; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Late-linked hands must still get their per-player rake ledger.
--
-- Under load the engine can bank a hand's rake with hand_id NULL (the
-- hand_history insert timed out; the retry queue writes it later and calls
-- fn_relink_rake_record_to_hand). atomic_distribute_rake correctly skips the
-- rake_attributions insert for a null hand id — but the relink then restored
-- hand_id WITHOUT the ledger, so a relinked weighted hand tripped
-- fn_rake_attribution_drift (6 hands caught by the watchdog on 2026-08-29,
-- clusters at 15:16 and 15:48 UTC). Fix at the source + backfill.

-- 1. Backfill helper: write any missing per-player ledger rows from the data
-- rake_records already holds. Idempotent (ON CONFLICT DO NOTHING), method-
-- aware, BBJ attribution included. Safe to run any time.
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

-- 2. Relink now finishes the job: hand_id AND the per-player ledger.
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

-- 3. Repair everything the gap already produced (ledger went live 2026-08-29
-- ~13:26 UTC), then ASSERT the watchdog reads clean. If it does not, this
-- migration aborts and nothing is claimed fixed.
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
