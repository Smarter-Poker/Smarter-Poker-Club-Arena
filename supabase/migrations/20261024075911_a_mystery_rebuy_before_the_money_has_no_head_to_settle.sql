-- 20261024075911_a_mystery_rebuy_before_the_money_has_no_head_to_settle
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-24 07:59:11 UTC.
--
-- WHAT WAS WRONG
--
-- No player, horse or human, could rebuy or re-enter a mystery-bounty event
-- before the money. Measured on production 2026-10-24: eight Union / Evening
-- Mystery Bounty events with rebuys on 22-23 October had 1,172 busts inside
-- the rebuy window and ZERO rebuys. Every attempt was refused with
--   "Atomic bounty rebuy claim refused: {"ok": true, "mode": "mystery_pre",
--    "claimed": true, "obligation_id": null,
--    "bounty_blocked": "mystery_bounties_start_in_the_money", ...}"
--
-- THE LINES THAT PRODUCED IT
--
-- A bounty-event rebuy first settles the old entry's head through the legacy
-- bounty claim. In a mystery event before activation (stage 'pending',
-- activation 'at_the_money') that claim correctly records the bust and writes
-- NO bounty obligation: there is no head yet, it stays in the bounty pool as
-- residual (the same rule an ordinary pre-money mystery elimination follows).
-- fn_ca_settle_bounty_rebuy_generation_v1 then required an obligation id, and
-- process_tournament_rebuy required a settled obligation with a complete
-- marker, twice. A case with nothing to settle could never pass either.
--
-- THE FIX
--
-- 1. fn_ca_settle_bounty_rebuy_generation_v1: when the claim succeeded, wrote
--    no obligation, reported mode 'mystery_pre' with bounty_blocked
--    'mystery_bounties_start_in_the_money', the event IS a mystery event and
--    the entry carries no head (current_bounty 0), return
--    no_bounty_head=true instead of refusing. Every other shape is refused
--    exactly as before.
-- 2. process_tournament_rebuy: sets v_no_bounty_head only from that exact
--    answer on a mystery event, and the two obligation checks accept a NULL
--    obligation only when v_no_bounty_head is true. Every other check in the
--    atomic proof (candidate rebought, seat, roster, stack, head funded by the
--    money core, table count) is unchanged.
--
-- Nothing to settle for the past: every refused purchase rolled back whole.
--
-- Both bodies are patched by exact anchor (each verified present exactly once
-- on production before this was written); process_tournament_rebuy also by
-- its measured md5. Requires 20261024072516 installed first. One transaction,
-- no hot-table lock.
--
-- Pinned by tests/a-mystery-rebuy-before-the-money-has-no-head-to-settle.law.test.ts.
--
-- @live-proof: (SELECT position('A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE' IN pg_get_functiondef('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure))>0) AND (SELECT position('A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE' IN pg_get_functiondef('public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure))>0)

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $mystery_pre_rebuy_has_no_head_to_settle$
DECLARE
  v_settle constant regprocedure :=
    'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure;
  v_rebuy constant regprocedure :=
    'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  v_marker constant text := 'A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE';
  v_src text;
  v_def text;
  v_old text;
  v_new text;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. The bounty rebuy step
  ---------------------------------------------------------------------------
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_settle;
  IF position('A BOUNTY REBUY NEVER BORROWS A HELD FINISHING PLACE' IN v_src) = 0 THEN
    RAISE EXCEPTION '20261024072516 must be installed before this migration';
  END IF;
  IF position(v_marker IN v_src) = 0 THEN
    v_def := pg_get_functiondef(v_settle);
    v_old := $old$    IF COALESCE((v_claim->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_claim->>'claimed')::boolean,false) IS NOT TRUE
       OR COALESCE(v_claim->>'obligation_id','')='' THEN
      RAISE EXCEPTION 'Atomic bounty rebuy claim refused: %',
$old$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'bounty rebuy claim-check anchor is not present exactly once';
    END IF;
    v_new := $new$    -- A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE (2026-10-24).
    -- Before activation the claim records the bust and writes no obligation:
    -- the head stays in the bounty pool as residual, exactly as for a
    -- pre-money mystery elimination. Nothing is owed, so the rebuy proceeds.
    IF COALESCE((v_claim->>'ok')::boolean,false)
       AND COALESCE((v_claim->>'claimed')::boolean,false)
       AND COALESCE(v_claim->>'obligation_id','')=''
       AND v_claim->>'mode'='mystery_pre'
       AND v_claim->>'bounty_blocked'='mystery_bounties_start_in_the_money'
       AND COALESCE(v_t.is_mystery_bounty,false) THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
           AND round(COALESCE(tp.current_bounty,0),2)<>0) THEN
        RAISE EXCEPTION 'Pre-money mystery rebuy found a live bounty head'
          USING ERRCODE='P0404';
      END IF;
      RETURN jsonb_build_object(
        'ok',true,'obligation_id',NULL,'mode','mystery_pre',
        'no_bounty_head',true,'old_head',0,
        'marker_verified',true,'old_head_cleared',true);
    END IF;
$new$ || v_old;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;

  ---------------------------------------------------------------------------
  -- 2. The rebuy door
  ---------------------------------------------------------------------------
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_rebuy;
  IF position(v_marker IN v_src) = 0 THEN
    IF md5(v_src) <> '19c487be1cc3564421751e4a6cace2a4' THEN
      RAISE EXCEPTION 'process_tournament_rebuy body changed (md5 %); refusing to patch a body this migration did not measure', md5(v_src);
    END IF;
    v_def := pg_get_functiondef(v_rebuy);

    v_old := E'  v_bounty_obligation_id uuid;\n';
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'process_tournament_rebuy declaration anchor is not present exactly once';
    END IF;
    v_def := replace(v_def, v_old,
      E'  v_bounty_obligation_id uuid;\n  v_no_bounty_head boolean:=false;\n');

    v_old := $old$      v_bounty_settlement:=
        public.fn_ca_settle_bounty_rebuy_generation_v1(
          p_tournament_id,p_user_id,v_candidate.id);
$old$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'process_tournament_rebuy settlement-call anchor is not present exactly once';
    END IF;
    v_def := replace(v_def, v_old, v_old || $new$      -- A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE (2026-10-24):
      -- only that exact answer, on a mystery event, may stand in for an
      -- obligation. Every other answer still needs a settled, marked one.
      v_no_bounty_head:=
        COALESCE(v_t.is_mystery_bounty,false)
        AND COALESCE(v_bounty_settlement->>'no_bounty_head','false')='true'
        AND v_bounty_settlement->>'mode'='mystery_pre'
        AND COALESCE(v_bounty_settlement->>'obligation_id','')='';
$new$);

    v_old := $old$         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id
              AND o.tournament_id=p_tournament_id
$old$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'process_tournament_rebuy settlement-guard anchor is not present exactly once';
    END IF;
    v_def := replace(v_def, v_old, $new$         OR NOT v_no_bounty_head AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id
              AND o.tournament_id=p_tournament_id
$new$);

    v_old := $old$         v_bounty_obligation_id IS NULL
         OR round(COALESCE(v_player.current_bounty,0),2) IS DISTINCT FROM
$old$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'process_tournament_rebuy proof null-obligation anchor is not present exactly once';
    END IF;
    v_def := replace(v_def, v_old, $new$         (v_bounty_obligation_id IS NULL AND NOT v_no_bounty_head)
         OR round(COALESCE(v_player.current_bounty,0),2) IS DISTINCT FROM
$new$);

    v_old := $old$         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id AND o.state='settled'
$old$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'process_tournament_rebuy proof settled-obligation anchor is not present exactly once';
    END IF;
    v_def := replace(v_def, v_old, $new$         OR NOT v_no_bounty_head AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id AND o.state='settled'
$new$);

    EXECUTE v_def;
  END IF;

  ---------------------------------------------------------------------------
  -- Read back both installs and their security
  ---------------------------------------------------------------------------
  IF position(v_marker IN (SELECT prosrc FROM pg_proc WHERE oid = v_settle)) = 0
     OR position(v_marker IN (SELECT prosrc FROM pg_proc WHERE oid = v_rebuy)) = 0 THEN
    RAISE EXCEPTION 'patched bodies did not install';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_settle AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'bounty rebuy step lost its security definer, settings or private grant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_rebuy AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'process_tournament_rebuy lost its security definer, settings or grants';
  END IF;
END
$mystery_pre_rebuy_has_no_head_to_settle$;

COMMIT;
