-- 20260909182236_bounty_rebuy_settles_the_old_head_before_the_new_generation
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 18:22:36 UTC.
--
-- A bounty player who chose Rebuy inside the open decision window could never
-- complete the purchase. process_tournament_rebuy correctly refused to replace
-- an entry generation until its exact bounty obligation was settled, while the
-- bounty elimination authority correctly refused to claim that generation
-- until the same decision window closed. Waiting was circular: the player could
-- neither rebuy nor close the old head while the choice was still valid.
--
-- This migration keeps both safety rules and removes the cycle at their common
-- root. The sole tournament chip-purchase transaction now owns one private
-- exact-generation step before it debits the rebuy: create or load the immutable
-- obligation for the accepted zero-stack hand, settle the fixed, PKO, or mystery
-- payout, prove its complete marker, and clear only that snapshotted old head.
-- Only then can the existing money core fund a new head, seat the player, mark
-- the candidate rebought, and store the response receipt. A refused payout,
-- missing marker, depleted mystery inventory, insufficient rebuy balance, or
-- failed seat assignment raises inside the same transaction, so none of the old
-- payout, new debit, new head, seat, candidate, or receipt can survive alone.
--
-- No historical row is reconstructed and no sweep, watcher, reconciler, retry
-- job, or alternate public money door is added. The helper is owner-only and
-- its only runtime caller is process_tournament_rebuy.

BEGIN;
SET LOCAL lock_timeout = '250ms';

-- Fixed and PKO heads settle through this platform-owned payer. The terminal
-- cutover re-declared the other bounty authorities but omitted this live
-- exact-generation source, causing its obligation payer to demand an operator
-- adjustment. This source is fixed code, not a caller-controlled provenance.
INSERT INTO public.ca_settle_sources(source,note) VALUES(
  'fn_collect_bounty',
  'Exact-generation fixed and PKO bounty payer used by the atomic live authority.')
ON CONFLICT (source) DO UPDATE SET note=EXCLUDED.note;

-- The generation ledger trigger was written for fixed and PKO rows before the
-- mystery payer began supplying its obligation id explicitly. It rejected the
-- exact mystery id solely because its mode was mystery_chest. Admit that mode
-- only when the durable row is itself marked as a revealed mystery payout;
-- cross-mode, wrong-event, wrong-player, and unbound rows still fail closed.
CREATE OR REPLACE FUNCTION public.fn_attach_bounty_ledger_obligation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $attach_bounty_ledger_generation$
DECLARE
  v_context text:=current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
  v_is_mystery boolean:=COALESCE(NEW.is_mystery_revealed,false);
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_obligation_id:=v_context::uuid;
      SELECT o.id INTO NEW.bounty_obligation_id
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id
         AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND ((v_is_mystery AND o.mode='mystery_chest')
              OR (NOT v_is_mystery AND o.mode<>'mystery_chest'));
      IF NEW.bounty_obligation_id IS NULL THEN
        RAISE EXCEPTION
          'bounty ledger context does not match its exact generation and mode'
          USING ERRCODE='check_violation';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_player_id
         AND o.state='pending'
         AND ((v_is_mystery AND o.mode='mystery_chest')
              OR (NOT v_is_mystery AND o.mode<>'mystery_chest'))
    ) THEN
      RAISE EXCEPTION
        'generation-bound bounty ledger insert has no exact obligation context'
        USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations o
     WHERE o.id=NEW.bounty_obligation_id
       AND o.tournament_id=NEW.tournament_id
       AND o.eliminated_user_id=NEW.eliminated_player_id
       AND ((v_is_mystery AND o.mode='mystery_chest')
            OR (NOT v_is_mystery AND o.mode<>'mystery_chest'))
  ) THEN
    RAISE EXCEPTION
      'bounty ledger names a mismatched obligation generation or mode'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$attach_bounty_ledger_generation$;

CREATE OR REPLACE FUNCTION public.fn_ca_settle_bounty_rebuy_generation_v1(
  p_tournament_id uuid,
  p_user_id uuid,
  p_candidate_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $bounty_rebuy_generation$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_obligation public.tournament_bounty_obligations%ROWTYPE;
  v_claim jsonb;
  v_result jsonb;
  v_reserve jsonb;
  v_award_id uuid;
  v_award_status text;
  v_chest_id uuid;
  v_seat_exit_token uuid;
  v_position integer;
  v_rows integer;
  v_head_after numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_candidate_id IS NULL THEN
    RAISE EXCEPTION 'Bounty rebuy requires one exact knockout generation'
      USING ERRCODE='22023';
  END IF;

  -- process_tournament_rebuy owns the terminal root, maintenance gate,
  -- tournament seat-acquisition root, and atomic table key before entering.
  -- Reacquire the exact rows here so this private step remains independently
  -- fail-closed if its caller ever drifts.
  SELECT * INTO v_t
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND OR upper(COALESCE(v_t.status::text,''))<>'RUNNING'
     OR NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
             OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RAISE EXCEPTION 'Bounty rebuy generation is not claimable'
      USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_player
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_player.status::text NOT IN ('playing','eliminated')
     OR COALESCE(v_player.chips,0)<>0 OR COALESCE(v_player.prize,0)<>0 THEN
    RAISE EXCEPTION 'Only the exact unpaid zero-stack bounty entry may be replaced'
      USING ERRCODE='55000';
  END IF;

  PERFORM c.id
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
   ORDER BY c.hand_number,c.id
   FOR UPDATE;
  SELECT * INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.id=p_candidate_id
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND
     OR v_candidate.id IS DISTINCT FROM
          public.fn_ca_latest_committed_knockout_candidate(
            p_tournament_id,p_user_id)
     OR v_candidate.state NOT IN ('pending','eliminated') THEN
    RAISE EXCEPTION 'Bounty rebuy does not name the latest committed knockout generation'
      USING ERRCODE='P0404';
  END IF;

  SELECT * INTO v_obligation
    FROM public.tournament_bounty_obligations o
   WHERE o.tournament_id=p_tournament_id
     AND o.eliminated_user_id=p_user_id
     AND o.table_id=v_candidate.table_id
     AND o.hand_id=v_candidate.hand_id
     AND o.hand_number=v_candidate.hand_number
     AND o.seat_joined_at=v_candidate.seat_joined_at
   FOR UPDATE;

  IF NOT FOUND THEN
    -- A new obligation may be born here only for the still-open generation
    -- this purchase is replacing. An already-eliminated generation must carry
    -- its durable outbox; this path never reconstructs one from history.
    IF v_candidate.state<>'pending'
       OR v_player.status::text<>'playing'
       OR v_candidate.rebuy_prompt_until IS NULL
       OR v_candidate.rebuy_prompt_until<=clock_timestamp() THEN
      RAISE EXCEPTION 'Bounty rebuy cannot create a missing closed-generation obligation'
        USING ERRCODE='P0404';
    END IF;

    -- This is an entry-generation knockout, not a final tournament result.
    -- The existing outbox schema requires the field position observed at the
    -- status CAS; prize is exactly zero and the money core clears the temporary
    -- position again before the transaction can commit.
    SELECT GREATEST(2,count(*)::integer) INTO v_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.status='playing';

    -- The exact claim also retires the zero-stack chair. Keep the permanent
    -- seat-exit guard intact by opening its one-use elimination capability in
    -- this same transaction and requiring the claim to consume it exactly.
    v_seat_exit_token:=public.fn_ca_open_tournament_seat_exit_authority(
      p_tournament_id,'elimination',p_user_id);
    BEGIN
      v_claim:=public.fn_claim_bounty_legacy_candidate_20260907(
        p_tournament_id,p_user_id,v_position,0,
        v_candidate.table_id,v_candidate.hand_id,v_candidate.hand_number,
        v_candidate.seat_joined_at,NULL,NULL,0,false);
      PERFORM public.fn_ca_close_tournament_seat_exit_authority(
        v_seat_exit_token,
        COALESCE((v_claim->>'ok')::boolean,false)
          AND COALESCE((v_claim->>'claimed')::boolean,false));
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.fn_ca_close_tournament_seat_exit_authority(
        v_seat_exit_token,false);
      RAISE;
    END;
    IF COALESCE((v_claim->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_claim->>'claimed')::boolean,false) IS NOT TRUE
       OR COALESCE(v_claim->>'obligation_id','')='' THEN
      RAISE EXCEPTION 'Atomic bounty rebuy claim refused: %',
        COALESCE(v_claim::text,'null') USING ERRCODE='P0404';
    END IF;

    SELECT * INTO v_obligation
      FROM public.tournament_bounty_obligations o
     WHERE o.id=(v_claim->>'obligation_id')::uuid
       AND o.tournament_id=p_tournament_id
       AND o.eliminated_user_id=p_user_id
       AND o.table_id=v_candidate.table_id
       AND o.hand_id=v_candidate.hand_id
       AND o.hand_number=v_candidate.hand_number
       AND o.seat_joined_at=v_candidate.seat_joined_at
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Atomic bounty rebuy claim returned no exact obligation'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  IF v_obligation.state='settled' THEN
    IF NOT public.fn_bounty_obligation_has_complete_marker(v_obligation.id) THEN
      RAISE EXCEPTION 'Settled bounty rebuy obligation has no complete marker'
        USING ERRCODE='P0404';
    END IF;
  ELSIF v_obligation.mode='mystery_chest' THEN
    v_reserve:=public.fn_mystery_bounty_reserve(
      p_tournament_id,p_user_id,v_obligation.claimants,
      v_obligation.table_id,v_obligation.hand_id::text,
      md5('mb:'||v_obligation.id::text)::uuid,1);
    IF COALESCE((v_reserve->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE(v_reserve->>'obligation_id','')<>v_obligation.id::text
       OR COALESCE(v_reserve->>'recipients_verified','false')<>'true' THEN
      RAISE EXCEPTION 'Atomic mystery-bounty rebuy reserve refused: %',
        COALESCE(v_reserve::text,'null') USING ERRCODE='P0404';
    END IF;
    BEGIN
      v_award_id:=(v_reserve->>'award_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Atomic mystery-bounty rebuy reserve returned no award id'
        USING ERRCODE='P0404';
    END;

    SELECT a.status,a.chest_id INTO v_award_status,v_chest_id
      FROM public.tournament_bounty_awards a
     WHERE a.id=v_award_id
       AND a.tournament_id=p_tournament_id
       AND a.eliminated_user_id=p_user_id
       AND a.bounty_obligation_id=v_obligation.id
     FOR UPDATE;
    IF NOT FOUND OR v_award_status NOT IN ('reserved','revealed','paid','completed') THEN
      RAISE EXCEPTION 'Atomic mystery-bounty rebuy award is not exact or payable'
        USING ERRCODE='P0404';
    END IF;

    -- The browser reveal RPC correctly trusts auth.uid(), so an authenticated
    -- busted player cannot impersonate the designated knocker. This owner-only
    -- purchase step performs the same two-row reveal transition under the
    -- already-held tournament lock before paying it immediately.
    IF v_award_status='reserved' THEN
      UPDATE public.tournament_bounty_awards a
         SET status='revealed',revealed_at=COALESCE(a.revealed_at,now())
       WHERE a.id=v_award_id AND a.status='reserved';
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'Atomic mystery-bounty rebuy award changed before reveal'
          USING ERRCODE='40001';
      END IF;
      UPDATE public.tournament_bounty_chests c
         SET status='revealed'
       WHERE c.id=v_chest_id AND c.status='reserved';
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 THEN
        RAISE EXCEPTION 'Atomic mystery-bounty rebuy chest changed before reveal'
          USING ERRCODE='40001';
      END IF;
    END IF;

    v_result:=public.fn_mystery_bounty_pay(v_award_id);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_result->>'refused_recipients')::integer,0)<>0 THEN
      RAISE EXCEPTION 'Atomic mystery-bounty rebuy payment refused: %',
        COALESCE(v_result::text,'null') USING ERRCODE='P0404';
    END IF;
  ELSE
    v_result:=public.fn_collect_bounty_obligation(v_obligation.id);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Atomic bounty rebuy payment refused: %',
        COALESCE(v_result::text,'null') USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_obligation
    FROM public.tournament_bounty_obligations o
   WHERE o.id=v_obligation.id
   FOR UPDATE;
  IF NOT FOUND OR v_obligation.state<>'settled'
     OR NOT public.fn_bounty_obligation_has_complete_marker(v_obligation.id) THEN
    RAISE EXCEPTION 'Bounty rebuy old head did not produce its exact settled marker'
      USING ERRCODE='P0404';
  END IF;

  -- Fixed and PKO collection already clear the old head. Mystery payout owns a
  -- chest rather than current_bounty, so clear that same snapshotted generation
  -- here. A different nonzero head means the generation changed and must abort.
  SELECT tp.current_bounty INTO v_head_after
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF round(COALESCE(v_head_after,0),2)<>0
     AND round(COALESCE(v_head_after,0),2)<>round(v_obligation.head_amount,2) THEN
    RAISE EXCEPTION 'Bounty rebuy old head changed before retirement'
      USING ERRCODE='40001';
  END IF;
  UPDATE public.tournament_players tp
     SET current_bounty=0
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND round(COALESCE(tp.current_bounty,0),2) IN
           (0,round(v_obligation.head_amount,2));
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
       AND round(COALESCE(tp.current_bounty,0),2)<>0
  ) THEN
    RAISE EXCEPTION 'Bounty rebuy old head was not retired exactly once'
      USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'obligation_id',v_obligation.id,
    'mode',v_obligation.mode,'old_head',v_obligation.head_amount,
    'marker_verified',true,'old_head_cleared',true);
END;
$bounty_rebuy_generation$;

REVOKE ALL ON FUNCTION
  public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

-- Patch the current sole authority in place. Every anchor is asserted so an
-- unexpected upstream body aborts rather than silently receiving a partial
-- edit. The installed process function remains the only public rebuy door.
DO $install_atomic_bounty_rebuy$
DECLARE
  v_def text;
  v_new text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef(
    'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure
  ) INTO v_def;

  v_old:='  v_rebuy_window jsonb;
  v_rows integer;';
  IF length(v_def)-length(replace(v_def,v_old,''))<>length(v_old) THEN
    RAISE EXCEPTION 'process_tournament_rebuy declaration anchor changed';
  END IF;
  v_new:=replace(v_def,v_old,'  v_rebuy_window jsonb;
  v_bounty_settlement jsonb;
  v_bounty_obligation_id uuid;
  v_rows integer;');

  v_old:=$old$    IF (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
        OR COALESCE(v_t.is_mystery_bounty,false))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations o
          WHERE o.tournament_id=p_tournament_id
            AND o.eliminated_user_id=p_user_id
            AND o.hand_number=v_candidate.hand_number
            AND o.hand_id=v_candidate.hand_id
            AND o.state='settled'
            AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
      RAISE EXCEPTION
        'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
        USING ERRCODE='55000';
    END IF;$old$;
  IF length(v_new)-length(replace(v_new,v_old,''))<>length(v_old) THEN
    RAISE EXCEPTION 'process_tournament_rebuy bounty guard anchor changed';
  END IF;
  v_new:=replace(v_new,v_old,$new$    IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
       OR COALESCE(v_t.is_mystery_bounty,false) THEN
      v_bounty_settlement:=
        public.fn_ca_settle_bounty_rebuy_generation_v1(
          p_tournament_id,p_user_id,v_candidate.id);
      BEGIN
        v_bounty_obligation_id:=
          (v_bounty_settlement->>'obligation_id')::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Bounty settlement returned no exact generation id'
          USING ERRCODE='P0404';
      END;
      IF COALESCE((v_bounty_settlement->>'ok')::boolean,false) IS NOT TRUE
         OR COALESCE(v_bounty_settlement->>'marker_verified','false')<>'true'
         OR COALESCE(v_bounty_settlement->>'old_head_cleared','false')<>'true'
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id
              AND o.tournament_id=p_tournament_id
              AND o.eliminated_user_id=p_user_id
              AND o.hand_number=v_candidate.hand_number
              AND o.hand_id=v_candidate.hand_id
              AND o.state='settled'
              AND public.fn_bounty_obligation_has_complete_marker(o.id)) THEN
        RAISE EXCEPTION
          'Bounty Settlement Pending - Rebuy Or Re-Entry Cannot Replace This Entry Generation Yet'
          USING ERRCODE='55000';
      END IF;
    END IF;$new$);

  v_old:=$old$       OR v_player.table_id IS DISTINCT FROM v_final_seat.table_id
       OR v_player.seat_number IS DISTINCT FROM v_final_seat.seat_number
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c$old$;
  IF length(v_new)-length(replace(v_new,v_old,''))<>length(v_old) THEN
    RAISE EXCEPTION 'process_tournament_rebuy final proof anchor changed';
  END IF;
  v_new:=replace(v_new,v_old,$new$       OR v_player.table_id IS DISTINCT FROM v_final_seat.table_id
       OR v_player.seat_number IS DISTINCT FROM v_final_seat.seat_number
       OR ((COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false)) AND (
         v_bounty_obligation_id IS NULL
         OR round(COALESCE(v_player.current_bounty,0),2) IS DISTINCT FROM
              round(COALESCE((v_response->>'bounty_head_funded')::numeric,0),2)
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_bounty_obligations o
            WHERE o.id=v_bounty_obligation_id AND o.state='settled'
              AND public.fn_bounty_obligation_has_complete_marker(o.id))))
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates c$new$);

  v_old:=$old$      'rebuy_type',v_type,'candidate_id',v_candidate.id,
      'candidate_state','rebought','seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'manager_wake_id',v_wake_id);$old$;
  IF length(v_new)-length(replace(v_new,v_old,''))<>length(v_old) THEN
    RAISE EXCEPTION 'process_tournament_rebuy response proof anchor changed';
  END IF;
  v_new:=replace(v_new,v_old,$new$      'rebuy_type',v_type,'candidate_id',v_candidate.id,
      'candidate_state','rebought','seat_id',v_final_seat.id,
      'table_id',v_final_seat.table_id,
      'seat_number',v_final_seat.seat_number,'stack',v_final_seat.stack,
      'prior_bounty_obligation_id',v_bounty_obligation_id,
      'prior_bounty_marker_verified',
        CASE WHEN v_bounty_obligation_id IS NULL THEN NULL ELSE true END,
      'manager_wake_id',v_wake_id);$new$);

  EXECUTE v_new;
END;
$install_atomic_bounty_rebuy$;

COMMENT ON FUNCTION public.process_tournament_rebuy(
  uuid,uuid,text,numeric,numeric,integer,text) IS
  'Sole rebuy, re-entry and add-on authority. A bounty rebuy first settles and retires the exact old head, then commits its wallet debit, newly funded head, positive live seat, roster mirrors, rebought candidate, manager wake, and immutable response receipt in the same transaction.';

DO $verify_atomic_bounty_rebuy$
DECLARE
  v_process text:=pg_get_functiondef(
    'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure);
  v_helper text:=pg_get_functiondef(
    'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure);
  v_ledger_trigger text:=pg_get_functiondef(
    'public.fn_attach_bounty_ledger_obligation()'::regprocedure);
  v_bounty_tail text;
BEGIN
  IF position('fn_ca_settle_bounty_rebuy_generation_v1' IN v_process)=0
     OR position('fn_ca_process_tournament_chip_purchase_money_v1' IN v_process)=0
     OR position('prior_bounty_obligation_id' IN v_process)=0
     OR position('public.fn_bounty_obligation_has_complete_marker' IN v_process)=0
     OR position('fn_claim_bounty_legacy_candidate_20260907' IN v_helper)=0
     OR position('fn_ca_open_tournament_seat_exit_authority' IN v_helper)=0
     OR position('fn_ca_close_tournament_seat_exit_authority' IN v_helper)=0
     OR position('fn_collect_bounty_obligation' IN v_helper)=0
     OR position('fn_mystery_bounty_reserve' IN v_helper)=0
     OR position('fn_mystery_bounty_pay' IN v_helper)=0
     OR position('SET current_bounty=0' IN v_helper)=0
     OR position('o.mode=''mystery_chest''' IN v_ledger_trigger)=0
     OR position('v_is_mystery' IN v_ledger_trigger)=0 THEN
    RAISE EXCEPTION 'Atomic bounty rebuy authority is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source='fn_collect_bounty') THEN
    RAISE EXCEPTION 'Fixed and PKO bounty payer is not an approved platform source';
  END IF;
  v_bounty_tail:=substring(
    v_process FROM position(
      'fn_ca_settle_bounty_rebuy_generation_v1' IN v_process));
  -- The add-on branch has an earlier money-core call. Prove the ordering only
  -- inside the bounty rebuy branch that begins at its settlement helper.
  IF position('fn_ca_process_tournament_chip_purchase_money_v1' IN v_bounty_tail)=0
     OR position('UPDATE public.tournament_knockout_candidates c' IN v_bounty_tail)=0
     OR position('fn_ca_process_tournament_chip_purchase_money_v1' IN v_bounty_tail)>
          position('UPDATE public.tournament_knockout_candidates c' IN v_bounty_tail) THEN
    RAISE EXCEPTION 'Bounty rebuy authority order is not payout then purchase then generation';
  END IF;
  IF has_function_privilege(
       'anon','public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'service_role','public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Private bounty rebuy generation helper is directly callable';
  END IF;
END;
$verify_atomic_bounty_rebuy$;

COMMIT;
