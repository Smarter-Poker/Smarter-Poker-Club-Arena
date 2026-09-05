-- 20260905171518_a_spin_pays_only_what_it_holds.sql
--
-- Dan, 2026-09-05, handing it back: flipping spins to enforced is mine.
--
-- CHIP-ACCOUNTING-ROADMAP Phase 5.2 has said "spins stay tracked, not refused,
-- until a soak" since escrow began covering them at 2026-09-05 03:00 UTC.
-- The soak, measured just now across every spin escrow row that exists:
--
--   status        rows   would-refuse   worst prize bank
--   COMPLETED     3913        0             0.00
--   CANCELLED      274        0             0.00
--   RUNNING         83        0            +2.00
--   REGISTERING     27        0            +2.00
--   COMPLETING       1        0             0.00
--
-- Not one bank has ever gone negative, cancelled spins refund exactly the
-- 13,280.00 they took, and R1/R5 report zero breaches. Enforcement would have
-- refused nothing.
--
-- BUT "IT WOULD HAVE REFUSED NOTHING" IS NOT "IT IS SAFE TO ENFORCE."
--
-- There is one path where a spin legitimately pays MORE than its escrow holds,
-- and it is deliberate. When the club reserve is too thin to cover the drawn
-- prize, fn_spin_settle_game draws only what is there, writes a SHORTFALL
-- adjustment row, and the players are paid in full anyway - the code says so in
-- as many words: "Players are paid in full regardless; this says the club needs
-- seeding." Turning enforcement on without touching that would convert a
-- deliberate operator top-up into a REFUSED PRIZE. A stranded player is exactly
-- what CLAUDE.md 10.9 exists to prevent, and it would have been caused by a
-- guard I switched on.
--
-- The shortfall has never fired: zero adjustment rows carrying SHORTFALL, ever.
-- That is why it is safe to fix now and unsafe to enforce without fixing.
--
-- WHY THE ESCROW CANNOT SEE IT TODAY. The shortfall is recorded only as prose
-- on an `adjustment` row whose amount is 0.00. No chip moves at settle time, so
-- no ledger leg fires, so tournament_escrow never learns that the operator has
-- promised the difference. That is an R8 completeness gap on its own terms,
-- independent of enforcement.
--
-- WHAT THIS DOES, all of it ADDITIVE - no money function is rewritten here.
-- fn_spin_settle_game and fn_ca_escrow_apply are Phase 5.2's and are left
-- exactly as they are; replacing either would risk clobbering in-flight work,
-- and a bad transcription of a settle function is worse than the bug.
--
--   A. A shortfall books itself into the escrow as overlay_in, so the event
--      genuinely holds what it is about to pay. Derived, never parsed out of
--      the note: shortfall = multiplier * buy_in - drawn, and every one of
--      those numbers is a column on the rows involved.
--   B. New spin escrow rows are born enforced - but only when they open with
--      every bank non-negative. A row that opens short stays tracked, so this
--      can never refuse a payment on an event that was already broken when the
--      escrow first saw it.
--   C. The rows that already exist are flipped, asserted, and only where the
--      banks are sound.
--
-- REVERTING IS ONE STATEMENT: UPDATE tournament_escrow SET enforced = false
-- for spins, plus dropping the two triggers. Nothing here is one-way.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── A. the operator's top-up is money the escrow must know about ────────────
CREATE OR REPLACE FUNCTION public.fn_spin_shortfall_funds_the_escrow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_drawn     numeric;
  v_prize     numeric;
  v_shortfall numeric;
BEGIN
  -- Only the shortfall marker. fn_spin_settle_game writes it with amount 0 and
  -- the numbers on the row itself, so nothing here reads prose.
  IF NEW.kind <> 'adjustment' OR NEW.note IS NULL OR NEW.note NOT LIKE 'SHORTFALL %' THEN
    RETURN NULL;
  END IF;
  IF COALESCE(NEW.multiplier, 0) <= 0 OR COALESCE(NEW.buy_in, 0) <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT -l.amount INTO v_drawn
    FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = NEW.tournament_id AND l.kind = 'jackpot_draw'
   ORDER BY l.created_at ASC LIMIT 1;

  v_prize     := round(NEW.multiplier * NEW.buy_in, 2);
  v_shortfall := round(v_prize - COALESCE(v_drawn, 0), 2);
  IF v_shortfall <= 0 THEN
    RETURN NULL;
  END IF;

  -- overlay_in is the escrow's word for "funded from outside the entries",
  -- which is precisely what an operator top-up is.
  PERFORM public.fn_ca_escrow_apply(
    NEW.tournament_id,
    'spin reserve shortfall covered by the operator',
    0, 0, 0, 0, v_shortfall
  );
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_shortfall_funds_the_escrow() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_spin_shortfall_funds_escrow ON public.spin_reserve_ledger;
CREATE TRIGGER zz_spin_shortfall_funds_escrow
  AFTER INSERT ON public.spin_reserve_ledger
  FOR EACH ROW
  WHEN (NEW.kind = 'adjustment')
  EXECUTE FUNCTION public.fn_spin_shortfall_funds_the_escrow();

COMMENT ON FUNCTION public.fn_spin_shortfall_funds_the_escrow() IS
  'When a spin draws more than its club reserve holds, the operator covers the '
  'difference and the players are paid in full. This books that top-up into '
  'tournament_escrow as overlay_in, so an enforced spin escrow can never refuse '
  'a prize the platform has already decided to pay.';

-- ── B. a new spin escrow row is born enforced, if it opens sound ────────────
CREATE OR REPLACE FUNCTION public.fn_spin_escrow_is_enforced()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NEW.enforced THEN
    RETURN NEW;
  END IF;
  -- Only spins: every other variant is already born enforced.
  IF NOT EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id = NEW.tournament_id
       AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false))
  ) THEN
    RETURN NEW;
  END IF;
  /* A row that opens SHORT stays tracked. fn_ca_escrow_apply can open an
     escrow "at first sight" from the shadow of an event already in flight, and
     an event that was broken before the escrow ever saw it must not have its
     next payment refused because of a guard switched on afterwards. */
  IF COALESCE(NEW.prize_balance, 0)  < -0.005
     OR COALESCE(NEW.bounty_balance, 0) < -0.005
     OR COALESCE(NEW.fee_balance, 0)    < -0.005 THEN
    RETURN NEW;
  END IF;
  NEW.enforced := true;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_escrow_is_enforced() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_spin_escrow_is_enforced ON public.tournament_escrow;
CREATE TRIGGER zz_spin_escrow_is_enforced
  BEFORE INSERT ON public.tournament_escrow
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_spin_escrow_is_enforced();

COMMENT ON FUNCTION public.fn_spin_escrow_is_enforced() IS
  'Spins were born tracked-not-enforced (fn_ca_escrow_apply opens them with '
  'enforced = NOT is_spin). After a soak showing zero would-refuse across every '
  'spin escrow row, they are born enforced - unless the row opens with a bank '
  'already negative, which stays tracked.';

-- ── C. the rows that already exist ─────────────────────────────────────────
DO $flip$
DECLARE
  v_unsound integer;
  v_flipped integer;
BEGIN
  SELECT count(*) INTO v_unsound
    FROM public.tournament_escrow e
    JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false))
     AND NOT e.enforced
     AND (e.prize_balance < -0.005 OR e.bounty_balance < -0.005 OR e.fee_balance < -0.005);

  IF v_unsound <> 0 THEN
    RAISE EXCEPTION
      'spin escrow flip: % row(s) carry a negative bank - enforcing them would refuse their next payment. Re-measure before shipping this.',
      v_unsound;
  END IF;

  UPDATE public.tournament_escrow e
     SET enforced = true, updated_at = now()
    FROM public.tournaments t
   WHERE t.id = e.tournament_id
     AND (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false))
     AND NOT e.enforced
     AND e.prize_balance  >= -0.005
     AND e.bounty_balance >= -0.005
     AND e.fee_balance    >= -0.005;
  GET DIAGNOSTICS v_flipped = ROW_COUNT;

  INSERT INTO public.financial_alerts
    (severity, source, message, context, resolved, resolved_at, resolution)
  VALUES ('info', 'spin_escrow_enforced_20260905',
          'Spin escrow moved from tracked to enforced on ' || v_flipped || ' rows',
          jsonb_build_object('rows_flipped', v_flipped,
                             'rows_left_tracked_for_a_negative_bank', v_unsound,
                             'shortfall_rows_ever', 0,
                             'would_refuse_at_flip', 0),
          true, now(),
          'ACCEPTED. Escrow began covering spins at 2026-09-05 03:00 UTC and every row it has ever '
          'held reads a non-negative bank: 3,913 completed, 274 cancelled refunding exactly what they '
          'took, 83 running, 27 registering, 1 completing, zero would-refuse in any of them, and zero '
          'R1/R5 breaches. The one path that legitimately pays more than the escrow holds is the '
          'operator shortfall, which has never fired and which now books itself as overlay_in '
          '(trigger zz_spin_shortfall_funds_escrow in this migration) so an enforced escrow cannot '
          'refuse a prize the platform has already decided to pay. A row that opens with a negative '
          'bank is left tracked rather than enforced. Reverting is one UPDATE plus two DROP TRIGGERs.');

  RAISE NOTICE 'spin escrow: % rows enforced, % left tracked', v_flipped, v_unsound;
END
$flip$;

COMMIT;
