DO $mig$
/* ==========================================================================
   Settling nothing needs no wallet, and level stats stop being a stub
   ==========================================================================

   2026-09-08. Three changes, ONE transaction and therefore ONE PostgREST
   schema-cache reload - CLAUDE.md section 2 rule 1, and the reason the phase 8
   pair cost eighteen hands is that they were two reloads three minutes apart.
   Applied inside the :55 maintenance break, when every table is parked at a
   hand boundary, so the reload cannot land on an in-flight hand at all.

   ---------------------------------------------------------------------------
   1. A DEPARTED SEAT THAT MOVED NOTHING NEEDS NO WALLET
   ---------------------------------------------------------------------------
   fn_ca_settle_hand_stacks_absolute refuses a whole hand when a seat that has
   left cannot be resolved to a club wallet - correctly, because that seat's
   delta has to be settled somewhere. But it demands the wallet BEFORE it works
   out whether the seat moved anything.

   Hand 7903456 is the worked example, from the eighteen hands the phase 8
   reload dropped: it nets to zero between two players who are both still
   seated, and it was refused whole because a THIRD seat, whose delta was
   0.00, had gone. Nothing needed to be written for that seat and nothing could
   have been.

   The departed loop already skips a zero delta two steps later
   (`IF v_dep.delta = 0 THEN CONTINUE`), so this only moves the same decision
   earlier, before the wallet is required. A seat that moved chips still needs
   its wallet and is still refused without one.

   The edit is applied as an ASSERTED TEXT SUBSTITUTION on the live definition
   rather than a retyped body: the function is ~250 lines of money code, and
   retyping it to change four is how an unrelated line gets lost. The migration
   aborts if the anchor is not found exactly once.

   ---------------------------------------------------------------------------
   2. get_user_level_stats STOPS BEING A STUB
   ---------------------------------------------------------------------------
   The live one-argument version returns a hard-coded
   {xp:0, level:1, xp_to_next:0, progress_pct:0} - an XP shape, from a function
   named for level statistics, read by a World Hub caller that wants
   {total_questions, correct_answers, accuracy, avg_ev_loss} per level. That
   caller passes (p_user_id, p_level_id), matched no signature, and has been
   answering PGRST202 since it was written.

   The CALLER was right, so the database is what changes: a two-argument
   overload computed from training_answers, which holds exactly those facts.

   SECURITY INVOKER, deliberately. RLS on training_answers is
   `training_answers_select_self` - a reader sees only their own rows - so the
   p_user_id argument cannot be turned into a way to read somebody else's
   record. A DEFINER function here would have to re-implement that check, and
   a check that has to be re-implemented is a check that eventually is not.

   The one-argument stub is left alone: Club Arena's useArenaStore.loadStats
   still calls it, expecting a third shape again. That action has no caller, so
   it moves no money and breaks no page; removing it belongs with the store.

   ---------------------------------------------------------------------------
   3. THE METER SAYS WHAT IT DOES NOT COVER
   ---------------------------------------------------------------------------
   fn_ca_currency_meter writes `enforced = true` for VIP points and agent
   commissions, and the rakeback row carries `not_enforced_because` in its
   detail. The two enforced rows say nothing about their edges, and
   CLAUDE.md 10.86 is precisely about a guard that answers confidently on a
   scope nobody stated. Said here as a COMMENT rather than by rewriting a
   working function for prose.

   ROLLBACK: re-apply the previous definition from the migration that created
   it. Nothing below writes a row; there is no data to restore.
   ========================================================================== */
DECLARE
  v_src  text;
  v_new  text;
  v_hits integer;
  v_anchor text := '          IF v_dep_club IS NULL OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = v_uid AND m.club_id = v_dep_club) THEN';
  v_insert text :=
    '          /* SETTLING NOTHING NEEDS NO WALLET (2026-09-08). A seat that left'  || E'\n' ||
    '             having moved no chips has nothing to settle against a wallet, and'|| E'\n' ||
    '             the departed loop below already skips a zero delta. Demanding the'|| E'\n' ||
    '             wallet first refused whole hands over seats that owed nothing -'  || E'\n' ||
    '             hand 7903456, which nets to zero between two seated players, was' || E'\n' ||
    '             refused because a third seat with a delta of 0.00 had gone. */'   || E'\n' ||
    '          IF round(v_new - v_before, 2) = 0 THEN'                              || E'\n' ||
    '            v_n := v_n + 1;'                                                   || E'\n' ||
    '            CONTINUE;'                                                         || E'\n' ||
    '          END IF;'                                                             || E'\n';
BEGIN
  -- ── 1. the settlement function ────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_settle_hand_stacks_absolute';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute not found';
  END IF;

  -- Already applied? Then this migration is a no-op for part 1.
  IF position('SETTLING NOTHING NEEDS NO WALLET' in v_src) > 0 THEN
    RAISE NOTICE 'part 1 already applied; skipping';
  ELSE
    v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        'expected exactly one departed-seat wallet check to anchor on, found % - the function has changed and this edit must be re-read against it',
        v_hits;
    END IF;
    v_new := replace(v_src, v_anchor, v_insert || v_anchor);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  -- ── 2. level stats, computed instead of invented ──────────────────────────
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.get_user_level_stats(p_user_id uuid, p_level_id integer)
    RETURNS TABLE (
      total_questions bigint,
      correct_answers bigint,
      accuracy        numeric,
      avg_ev_loss     numeric
    )
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path TO 'public'
    AS $body$
      SELECT
        count(*)::bigint,
        count(*) FILTER (WHERE a.is_correct)::bigint,
        CASE WHEN count(*) = 0 THEN 0::numeric
             ELSE round(100.0 * count(*) FILTER (WHERE a.is_correct) / count(*), 2) END,
        COALESCE(round(avg(a.ev_loss)::numeric, 4), 0)
      FROM public.training_answers a
      WHERE a.user_id = p_user_id
        AND a.level = p_level_id;
    $body$;
  $fn$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.get_user_level_stats(uuid, integer) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_user_level_stats(uuid, integer) TO authenticated, service_role';

  EXECUTE $c$
    COMMENT ON FUNCTION public.get_user_level_stats(uuid, integer) IS
      'Training accuracy for one player at one level, from training_answers. SECURITY INVOKER on purpose: RLS (training_answers_select_self) is what stops p_user_id reading somebody else''s record, so the check is not re-implemented here. The one-argument overload of this name is an unrelated stub returning fixed XP fields.'
  $c$;

  -- ── 3. the meter states its edges ─────────────────────────────────────────
  EXECUTE $c$
    COMMENT ON FUNCTION public.fn_ca_currency_meter() IS
      'Nightly conservation meter for the currencies that are not chips. ENFORCED: vip_points against vip_points_ledger, and agent_commission_unsettled_rollup against unsettled agent_commissions - both hold by construction because the journals are append-only and the balance moves only with a leg, so a drift is a CRITICAL incident meaning a guard was bypassed or dropped. NOT ENFORCED, and deliberately: rakeback (three sources disagree by design while fn_close_settlement_period is another lane''s live rebuild; the row carries not_enforced_because and raises a WARNING with the numbers). NOT COVERED AT ALL: vip_points_carry, the fractional remainder between awards, which no guard watches; and the commission rollup is COMPARED here rather than guarded, its correctness resting on the statement triggers that maintain it. Cost is O(journal) - 10.2s at 5.75M VIP legs, growing ~306k/day against job 286''s 600s budget.'
  $c$;

  RAISE NOTICE 'applied: departed-zero-delta, get_user_level_stats(uuid,integer), meter scope comment';
END $mig$;
