-- 20261008140724_a_redeemed_satellite_ticket_is_not_extra_seat_evidence_applied.sql
--
-- The edit 20261008140504 describes, with a guard that cannot mistake the
-- receipts' existing ticket clause for its own: skip only when
-- 'tk.holder_id = tp.user_id' is present, prove exactly two sites per
-- receipt (Diamond and chip branch) afterwards. Read 20261008140504 for the
-- measurement and the reasoning; this file is what changed production.
--
-- PROVED after apply at 14:08Z: all 562 satellites completed in the last
-- seven days replay their receipt clean on the live functions (328 refused
-- before), and the two first samples (00047f1f cohort, 0303a69f single)
-- return fully_settled.
--
-- @live-proof: (SELECT (length(d) - length(replace(d, 'tk.holder_id = tp.user_id', ''))) / length('tk.holder_id = tp.user_id') = 2 FROM (SELECT pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure) d) x)

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
  v_anchor := $a$       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)$a$;
  v_ins := $i$       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)$i$;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',   'b77ddbf69afdb53bd342e6e0c0f3a5a2'),
      ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)', '34f61b69fa205cc61a2f6b16b8b57be2')) AS x(fn, pre)
  LOOP
    v_src := pg_get_functiondef(r.fn::regprocedure);
    IF position('tk.holder_id = tp.user_id' in v_src) > 0 THEN
      RAISE NOTICE '% already admits a redeemed ticket registration; skipping', r.fn;
      CONTINUE;
    END IF;
    v_md5 := md5(v_src);
    IF v_md5 <> r.pre THEN
      RAISE EXCEPTION 'preimage: % is % not % - re-read this edit against the live body', r.fn, v_md5, r.pre;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 2 THEN
      RAISE EXCEPTION '% carries the extra-registration clause % times, expected 2 (Diamond and chip branches)', r.fn, v_n;
    END IF;
    EXECUTE replace(v_src, v_anchor, v_ins);
  END LOOP;
END
$mig$;

DO $prove$
DECLARE v_c text; v_s text;
BEGIN
  v_c := pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure);
  v_s := pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure);
  IF (length(v_c) - length(replace(v_c, 'tk.holder_id = tp.user_id', ''))) / length('tk.holder_id = tp.user_id') <> 2
     OR (length(v_s) - length(replace(v_s, 'tk.holder_id = tp.user_id', ''))) / length('tk.holder_id = tp.user_id') <> 2 THEN
    RAISE EXCEPTION 'a redeemed ticket registration is still read as extra seat evidence in one branch';
  END IF;
END
$prove$;

COMMIT;
