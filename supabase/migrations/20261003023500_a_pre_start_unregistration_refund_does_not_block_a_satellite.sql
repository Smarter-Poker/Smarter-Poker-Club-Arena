-- ============================================================================
-- A PRE-START UNREGISTRATION REFUND DOES NOT BLOCK A SATELLITE'S FINISH
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03 01:43-02:30 UTC.
--
-- WHAT HAPPENED
--
-- Satellite 65e8497e "Sunday Deep Stack Satellite $5" (target 851d664a) was
-- down to one player at 01:43 and could not finish. Every atomic finish was
-- refused with
--
--     satellite 65e8497e-... has partial or legacy settlement evidence
--
-- and filed two CRITICAL drift incidents (c9f59d93 refused, a3160e84 outcome
-- unknown), which reset the 24-hour burn-in launch gate. The winner was unpaid.
--
-- The "evidence" was one row in tournament_obligations:
--     kind 'refund', source 'fn_unregister_from_tournament', 5.00 owed,
--     5.00 paid, settled 2026-10-02 19:04:52 - a player who unregistered
--     before the event started and was refunded in full.
-- The satellite settlement requires that a new settlement starts with NO
-- obligation rows at all (to catch a half-written earlier settlement), and
-- its receipt requires the obligation count to equal exactly the cash
-- tickets plus one remainder. A settled pre-start refund is neither a
-- settlement fragment nor a settlement obligation, so any satellite in which
-- someone unregistered could never finish. fn_unregister_from_tournament has
-- written such rows since 2026-09-26; two exist in ten days; this is the
-- only satellite affected (the other was not a satellite).
--
-- THE CHANGE
--
-- In the fresh-settlement guard of fn_settle_satellite_tournament_pre_money_path_gate
-- and fn_ca_settle_satellite_cohort, and in the obligation count of
-- fn_ca_satellite_settlement_receipt, a row is ignored only when ALL hold:
--     kind = 'refund' AND source = 'fn_unregister_from_tournament'
--     AND settled_at IS NOT NULL AND amount_paid = amount_owed.
-- Every other obligation (place, seat, remainder, bounty, cancel refund, an
-- unsettled or partly paid unregistration refund) still refuses exactly as
-- before. No pool, ticket, seat, fee or escrow arithmetic changes: the
-- refunded entry already left the pool when it was refunded.
--
-- PROVED BEFORE APPLY in a rolled-back transaction on production: with these
-- three substitutions fn_settle_satellite_tournament(65e8497e, winner 7f2fcb20)
-- returned ok, pool 200.00, one 200.00 target ticket to the winner, status
-- COMPLETED, fee bank 12.00 recognized, receipt_version 2, fully_settled.
--
-- @live-proof: (SELECT position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_ins text; v_n int; v_md5 text;
  r record;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  -- 1. The fresh-settlement guard, in both satellite settlement entries.
  v_anchor := $a$OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id)$a$;
  v_ins := $i$OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
                            AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed))$i$;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)', 'fe3a0b35548de1bf514e6d81244c7361'),
      ('public.fn_ca_settle_satellite_cohort(uuid,uuid[])',                    'ea1a6fcf0205b1b68ffc6192fe979bde')) AS x(fn, pre)
  LOOP
    v_src := pg_get_functiondef(r.fn::regprocedure);
    IF position('fn_unregister_from_tournament' in v_src) > 0 THEN
      RAISE NOTICE '% already admits a settled pre-start refund; skipping', r.fn;
      CONTINUE;
    END IF;
    v_md5 := md5(v_src);
    IF v_md5 <> r.pre THEN
      RAISE EXCEPTION 'preimage: % is % not % - re-read this edit against the live body', r.fn, v_md5, r.pre;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '% carries the obligation guard % times, expected 1', r.fn, v_n;
    END IF;
    EXECUTE replace(v_src, v_anchor, v_ins);
  END LOOP;

  -- 2. The receipt's obligation count.
  v_src := pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure);
  IF position('fn_unregister_from_tournament' in v_src) = 0 THEN
    v_md5 := md5(v_src);
    IF v_md5 <> 'd3618057bb26d64c651344baaac198e8' THEN
      RAISE EXCEPTION 'preimage: fn_ca_satellite_settlement_receipt is % - re-read this edit', v_md5;
    END IF;
    v_anchor := $a$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id;$a$;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the receipt carries the obligation count % times, expected 1', v_n;
    END IF;
    EXECUTE replace(v_src, v_anchor, $i$  SELECT count(*) INTO v_rows
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND NOT (o.kind = 'refund' AND o.source = 'fn_unregister_from_tournament'
              AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);$i$);
  END IF;
END
$mig$;

DO $prove$
BEGIN
  IF position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure)) = 0
     OR position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_ca_settle_satellite_cohort(uuid,uuid[])'::regprocedure)) = 0
     OR position('fn_unregister_from_tournament' in pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'a settled pre-start refund is not admitted by every satellite settlement check';
  END IF;
END
$prove$;

COMMIT;
