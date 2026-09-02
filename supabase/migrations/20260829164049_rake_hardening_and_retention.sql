-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829164049; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PR-A part 1: hardening, dead-code removal, ops tooling, retention.

-- ── 1. fn_hand_rake_breakdown: authorised eyes only ─────────────────────────
-- Was executable by any authenticated user and exposed every player's
-- per-hand contributions. Now: engine/service roles, the hand's club owner,
-- or a union overseer of that club.
CREATE OR REPLACE FUNCTION public.fn_hand_rake_breakdown(p_hand_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rr record;
  v_players jsonb;
  v_allocated numeric;
  v_caller uuid := auth.uid();
BEGIN
  SELECT * INTO v_rr FROM public.rake_records WHERE hand_id = p_hand_id
   ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF NOT public.fn_caller_is_engine() THEN
    IF v_caller IS NULL
       OR (NOT EXISTS (SELECT 1 FROM public.clubs c
                        WHERE c.id = v_rr.club_id AND c.owner_id = v_caller)
           AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
                            WHERE uc.club_id = v_rr.club_id
                              AND public.fn_is_union_overseer(uc.union_id, v_caller)))
    THEN
      RETURN jsonb_build_object('found', false, 'error', 'not_authorised');
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', ra.player_id,
           'gross_contribution', ra.gross_contribution,
           'returned_uncalled', ra.returned_uncalled,
           'eligible_contribution', ra.eligible_contribution,
           'contribution_weight', ra.contribution_weight,
           'weighted_rake_credit', ra.weighted_rake_credit,
           'bbj_attributed_contribution', ra.bbj_attributed_contribution
         ) ORDER BY ra.weighted_rake_credit DESC), '[]'::jsonb),
         COALESCE(SUM(ra.weighted_rake_credit), 0)
    INTO v_players, v_allocated
    FROM public.rake_attributions ra WHERE ra.hand_id = p_hand_id;

  RETURN jsonb_build_object(
    'found', true,
    'hand_id', p_hand_id,
    'rake_method', v_rr.rake_method,
    'gross_pot', v_rr.pot_size,
    'regular_rake_collected', v_rr.rake_amount,
    'bbj_drop_collected', v_rr.bbj_contribution,
    'net_pot_paid_to_players',
      CASE WHEN v_rr.pot_size IS NULL THEN NULL
           ELSE v_rr.pot_size - v_rr.rake_amount - COALESCE(v_rr.bbj_contribution, 0) END,
    'total_eligible_contributions', (
      SELECT COALESCE(SUM((e.value)::numeric), 0)
        FROM jsonb_each(COALESCE(v_rr.player_contributions, '{}'::jsonb)) e
       WHERE jsonb_typeof(e.value) = 'number' AND (e.value)::numeric > 0),
    'players', v_players,
    'reconciliation', jsonb_build_object(
      'expected_regular_rake', round(v_rr.rake_amount, 2),
      'allocated_regular_rake', round(v_allocated, 2),
      'difference', round(v_rr.rake_amount - v_allocated, 2),
      'valid', (round(v_allocated, 2) = round(v_rr.rake_amount, 2))
    )
  );
END $function$;

REVOKE ALL ON FUNCTION public.fn_hand_rake_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_hand_rake_breakdown(uuid) TO authenticated, service_role;

-- ── 2. settle_club_rakeback: engine or club owner only ──────────────────────
-- SECURITY DEFINER writer, was callable by any authenticated user for any
-- club. Payouts were already server-recomputed so no misdirection was
-- possible, but a stranger could still force-close another club's periods.
CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_period record;
  v_settled integer := 0;
  v_total_payout numeric := 0;
  v_close_result jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;
  -- Weighted-rake hardening 2026-08-29: who is asking?
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.clubs c
                          WHERE c.id = p_club_id AND c.owner_id = auth.uid())) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
  LOOP
    v_close_result := public.fn_close_settlement_period(v_period.id);
    IF (v_close_result->>'success')::boolean THEN
      v_settled := v_settled + 1;
      v_total_payout := v_total_payout + COALESCE((v_close_result->>'payout')::numeric, 0);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true,
    'club_id', p_club_id, 'periods_settled', v_settled, 'total_payout', v_total_payout);
END $function$;

-- ── 3. Dead attribution-era functions ────────────────────────────────────────
-- record_hand_rake_attribution OVERWROTE rake_records.player_contributions
-- wholesale; get_player_rake_total summed a wallet category cash players
-- never receive. Zero callers in code or DB. Gone.
DROP FUNCTION IF EXISTS public.record_hand_rake_attribution(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.get_player_rake_total(uuid);
DROP FUNCTION IF EXISTS public.get_player_rake_total(uuid, uuid);
-- record_rake STAYS (fn_union_law_selftest asserts its union guard;
-- settle_hand_atomically references it) but no browser may call it.
REVOKE ALL ON FUNCTION public.record_rake(uuid, uuid, uuid, numeric, numeric, integer, jsonb, boolean, uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_rake(uuid, uuid, uuid, numeric, numeric, integer, jsonb, boolean, uuid, numeric) TO service_role;

-- ── 4. The dead hands family: locked and labelled ────────────────────────────
-- hands / hand_players / hand_actions: 0 rows, 0 inserts ever, no triggers.
-- The FK from rake_attributions to hands caused the 2026-08-29 banking
-- outage. Browser write access is revoked so no dormant client path can ever
-- resurrect them silently; a future awakening fails loudly instead.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.hands, public.hand_players, public.hand_actions FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.hands IS 'RETIRED 2026-08-29 (weighted rake sweep): empty forever, no writers. Live hands are hand_history. Its FK on rake_attributions caused the 2026-08-29 rake banking outage. Do not point anything at this table.';
COMMENT ON TABLE public.hand_players IS 'RETIRED 2026-08-29: empty forever, no writers. Live data: hand_history.players / ca_hand_facts.';
COMMENT ON TABLE public.hand_actions IS 'RETIRED 2026-08-29: empty forever, no writers. Live data: hand_history.actions.';

-- ── 5. Ops: one sanctioned re-drive for queued rake ──────────────────────────
-- Encapsulates what the 2026-08-29 FK-outage recovery did by hand: re-drive
-- open rake rows through atomic_distribute_rake (idempotent, method-aware),
-- resolving a missing hand id from hand_history. Includes attempts-exhausted
-- rows: this IS the manual path the cap defers to.
CREATE OR REPLACE FUNCTION public.fn_redrive_unbanked_rake(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_hand uuid; v_ok int := 0; v_failed int := 0; v_already int := 0;
BEGIN
  FOR r IN SELECT p.* FROM public.pending_fee_distributions p
           WHERE p.resolved_at IS NULL AND p.kind = 'rake'
           ORDER BY p.created_at
           LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  LOOP
    v_hand := r.hand_id;
    IF v_hand IS NULL AND r.hand_number >= 1000000 THEN
      SELECT id INTO v_hand FROM public.hand_history WHERE hand_number = r.hand_number LIMIT 1;
    END IF;
    IF v_hand IS NOT NULL AND EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = v_hand) THEN
      v_already := v_already + 1;
      CONTINUE;
    END IF;
    BEGIN
      PERFORM public.atomic_distribute_rake(
        r.table_id, r.club_id, v_hand, r.hand_number::integer, r.rake, r.bbj,
        r.pot, r.num_players, r.contributions, r.tournament_id,
        r.returned_uncalled, COALESCE(r.rake_method, 'DEALT_EQUAL'));
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'redriven', v_ok,
    'already_banked', v_already, 'failed', v_failed);
END $function$;

REVOKE ALL ON FUNCTION public.fn_redrive_unbanked_rake(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_redrive_unbanked_rake(integer) TO service_role;

-- ── 6. Retention: the ledger follows the hand-history ruling ─────────────────
-- Dan's one sanctioned storage asymmetry (10.5): horse-only hands prune after
-- hand_history_retention_policy.horse_retention_days, human hands keep
-- forever. The per-player rake ledger now follows the SAME knob in the SAME
-- pass: when sp_prune_hand_history deletes a horse-only hand, that hand's
-- rake_attributions rows go with it. rake_records (the money ledger) is
-- never pruned, and every ledger consumer falls back to the canonical
-- allocator when ledger rows are absent, so no total ever changes.
CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_budget    constant interval := interval '20 seconds';
  v_deadline  timestamptz := clock_timestamp() + v_budget;
  v_days      integer;
  v_window    interval;
  v_doomed    uuid[];
  v_keepers   uuid[];
  v_deleted   integer := 0;
  v_round     integer;
begin
  select greatest(coalesce(horse_retention_days, 7), 1)
    into v_days
    from public.hand_history_retention_policy
   limit 1;

  if v_days is null then
    v_days := 7;
  end if;
  v_window := make_interval(days => v_days);

  loop
    v_doomed  := null;
    v_keepers := null;

    with candidates as (
      select hh.id, hh.players
        from public.hand_history hh
       where hh.has_human is distinct from true
         and hh.reported is not true
         and hh.created_at < now() - v_window
         -- A HAND THAT HIT THE JACKPOT IS NEVER A CANDIDATE.
         -- bbj_payouts links to it only by (table_id, hand_number) and
         -- bbj_payouts.hand_id is always NULL, so a deleted hand is
         -- unrecoverable and fn_bbj_hand_detail goes dark for that winner
         -- permanently. See the header.
         and not exists (
               select 1
                 from public.bbj_payouts bp
                where bp.table_id = hh.table_id
                  and bp.hand_number = hh.hand_number
             )
       order by hh.created_at
       limit p_batch
       for update skip locked
    ),
    classified as (
      select c.id,
             case
               when jsonb_typeof(c.players) is distinct from 'array' then true
               when jsonb_array_length(c.players) = 0 then true
               else exists (
                 select 1
                   from jsonb_array_elements(c.players) e
                   left join public.profiles p
                          on p.id = (
                               case when length(e.value->>'userId') = 36
                                     and (e.value->>'userId') ~
                                         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                    then (e.value->>'userId')::uuid end
                             )
                  where p.id is null
                     or p.is_horse is not true
               )
             end as is_human
        from candidates c
    )
    select array_agg(id) filter (where is_human is false),
           array_agg(id) filter (where is_human is distinct from false)
      into v_doomed, v_keepers
      from classified;

    exit when v_doomed is null and v_keepers is null;

    if v_keepers is not null and cardinality(v_keepers) > 0 then
      update public.hand_history
         set has_human = true
       where id = any(v_keepers);
    end if;

    if v_doomed is not null and cardinality(v_doomed) > 0 then
      -- WEIGHTED CONTRIBUTED RAKE (2026-08-29): the per-player rake ledger of
      -- a pruned horse-only hand goes with the hand. Same knob, same pass.
      -- rake_records keeps the money truth forever; consumers recompute via
      -- fn_allocate_rake_credits when ledger rows are absent.
      delete from public.rake_attributions where hand_id = any(v_doomed);
      delete from public.hand_history where id = any(v_doomed);
      get diagnostics v_round = row_count;
      v_deleted := v_deleted + v_round;
    end if;

    exit when clock_timestamp() >= v_deadline;
  end loop;

  return v_deleted;
end
$function$;

-- Backfill must never resurrect a pruned ledger: only hands whose
-- hand_history row still exists are eligible.
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
     AND EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.id = r.hand_id)
     AND NOT EXISTS (SELECT 1 FROM public.rake_attributions ra WHERE ra.hand_id = r.hand_id)
  ON CONFLICT (hand_id, player_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $function$;

-- ── 7. BBJ page reads the exact persisted attribution ────────────────────────
-- fn_bbj_my_contribution estimated fee x contribution / pot at read time.
-- Post-migration hands carry the exact persisted bbj_attributed_contribution;
-- use it, keep the estimate as the fallback for hands without ledger rows.
CREATE OR REPLACE FUNCTION public.fn_bbj_my_contribution(p_pool_id uuid, p_days integer DEFAULT 90)
RETURNS TABLE(attributed_chips numeric, hands_contributed bigint, days_covered integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club_ids uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::bigint, p_days;
    RETURN;
  END IF;

  SELECT ARRAY(
    SELECT c.id FROM public.clubs c
    WHERE c.union_id = (SELECT bp.union_id FROM public.bbj_pools bp WHERE bp.id = p_pool_id)
       OR c.id = (SELECT bp.club_id FROM public.bbj_pools bp WHERE bp.id = p_pool_id)
  ) INTO v_club_ids;

  IF v_club_ids IS NULL OR array_length(v_club_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::bigint, p_days;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    ROUND(COALESCE(SUM(
      COALESCE(
        ra.bbj_attributed_contribution,
        rr.bbj_contribution
          * ((rr.player_contributions->>v_uid::text)::numeric)
          / NULLIF(rr.pot_size, 0)
      )
    ), 0), 2),
    COUNT(*)::bigint,
    p_days
  FROM public.rake_records rr
  LEFT JOIN public.rake_attributions ra
    ON ra.hand_id = rr.hand_id AND ra.player_id = v_uid
  WHERE rr.player_contributions ? v_uid::text
    AND rr.club_id = ANY(v_club_ids)
    AND COALESCE(rr.bbj_contribution, 0) > 0
    AND rr.created_at > now() - make_interval(days => p_days)
    AND COALESCE((rr.player_contributions->>v_uid::text)::numeric, 0) > 0;
END;
$function$;
