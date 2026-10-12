-- ===========================================================================
--  THE OVERPAY RATCHET DOES NOT COUNT A REGISTRATION REFUND AS A PRIZE
-- ===========================================================================
--
-- fn_ca_ratchet_watch raised a CRITICAL settlement_error at 2026-10-05 00:29
-- UTC (dedupe ratchet:prize_overpay_unexplained_10d:above:0:2026-10-05,
-- actual 8 against a baseline of 0). It read as "eight tournaments paid more
-- than their prize pool". None did.
--
-- READ FROM ROWS, 2026-10-05: fn_ca_prize_overpay_unexplained('10 days')
-- returned nine completed events (eight inside the ratchet's 48 hours). On
-- every one of the nine, the reported excess equals, to the cent, the sum of
-- that event's wallet credits of category 'refund':
--
--   Mystery Bounty 5 PM CT          pool 240.00  paid 720.00  refund 480.00
--   DSS Sunday $16.50 Bounty Hunter pool 144.00  paid 504.00  refund 360.00
--   Progressive Knockout 5 PM CT    pool 144.00  paid 504.00  refund 360.00
--   Mystery Bounty 6 PM CT          pool 240.00  paid 500.00  refund 260.00
--   Bounty Knockout 5 PM CT         pool 156.00  paid 396.00  refund 240.00
--   Progressive Knockout 6 PM CT    pool 144.00  paid 294.00  refund 150.00
--   Bounty Knockout 6 PM CT         pool 156.00  paid 306.00  refund 150.00
--   DSS Sunday $8.80 PLO6 Turbo     pool 216.00  paid 296.00  refund  80.00
--   Sunday Funday Six-Card Closer   pool 1200.00 paid 1250.00 refund  50.00
--
-- A registration refund hands a player back a buy-in that never entered the
-- prize pool. The detector summed every 'credit' tied to the tournament
-- except bounties, so each refunded registration read as an overpay of
-- exactly that refund. Conservation held on each event: buy-ins minus
-- refunds equals prize plus bounty plus fee.
--
-- THE FIX IS THE LINE THAT PRODUCED THE WRONG NUMBER (CLAUDE.md 10.11): the
-- detector excludes category 'refund' alongside 'bounty'. Nothing else in it
-- moves; its window, threshold and the ratchet's baseline of 0 stay, so a
-- real overpay still pages at once. Measured read-only before this file:
-- with refunds excluded the 48-hour count is 0 and the 10-day set is empty.
-- No money moves, no row is rewritten, and nothing is clawed back (10.9).
--
-- The migration then asserts fn_ca_prize_overpay_count() is 0 and closes the
-- open ratchet incident through fn_ca_incident_action, naming the cause and
-- this correction. If the count is not 0 the whole file rolls back.
--
-- HOW: exact substitution through the pg_temp helper of
-- 20261004224309, preimage md5 pinned, anchor proved unique, postimage md5
-- computed read-only on production, owner/security/settings/grants asserted
-- unmoved. Applied outside the :50-:03 break window.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_prize_overpay_unexplained(interval)'::regprocedure)) = '5fdb9c82f01aabe5646b4ff9ed7a96da')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;


SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_prize_overpay_unexplained(interval)',
  '147bafc6a430aa6611b69ab8e6707268', '5fdb9c82f01aabe5646b4ff9ed7a96da',
  ARRAY[$o$                        -- prize pool, and is reconciled by its own check
                        AND COALESCE(w.category, '') <> 'bounty'), 0) AS paid
$o$],
  ARRAY[$n$                        -- prize pool, and is reconciled by its own check.
                        -- A registration refund hands back a buy-in that
                        -- never became prize money, so it is not a payout
                        -- either (2026-10-05): counting it read every
                        -- refunded registration as an overpay of exactly
                        -- that refund.
                        AND COALESCE(w.category, '') NOT IN ('bounty', 'refund')), 0) AS paid
$n$]);

-- The detector this ratchet reads now reads zero, measured against the same
-- 48 hours fn_ca_prize_overpay_count() counts. If it does not, a real overpay
-- exists and nothing below may close the incident.
DO $v$
BEGIN
  IF public.fn_ca_prize_overpay_count() <> 0 THEN
    RAISE EXCEPTION 'fn_ca_prize_overpay_count() is % after excluding refunds; an overpay is real',
      public.fn_ca_prize_overpay_count();
  END IF;
END $v$;

-- Close the ratchet incidents this false positive raised, through the
-- platform's own resolver, with the cause and the correction named.
SELECT public.fn_ca_incident_action(
         i.id, 'resolve',
         'Not an overpay. Every flagged event paid out exactly its prize pool; the excess was a registration refund, category refund, counted as a payout. Conservation held on each: buy-ins minus refunds equals prize plus bounty plus fee.',
         NULL,
         'fn_ca_prize_overpay_unexplained counted wallet credits of category refund as prize payouts.',
         'migration 20261005111107')
  FROM public.ca_drift_incidents i
 WHERE i.source = 'fn_ca_ratchet_watch'
   AND i.dedupe_key LIKE 'ratchet:prize_overpay_unexplained_10d:%'
   AND i.resolved_at IS NULL;

DO $v$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents i
              WHERE i.source = 'fn_ca_ratchet_watch'
                AND i.dedupe_key LIKE 'ratchet:prize_overpay_unexplained_10d:%'
                AND i.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'an overpay ratchet incident is still open';
  END IF;
END $v$;

COMMIT;
