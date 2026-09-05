-- ═══════════════════════════════════════════════════════════════════════════
--  AN APPROVAL CAN BE RETRIED, AND A DECLARED FREEZE MEANS SOMETHING
--  Club Operations upgrade, phase 7 of 8 (money movement). 2026-09-05.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The write paths themselves are the best-defended code in this workspace and
-- this migration does not touch them: `fn_agent_wallet_send` still takes its
-- mandatory retry key, takes its advisory lock, replays on the op id and
-- refuses a key that belongs to a different intent. What was wrong is the two
-- things wrapped AROUND them.
--
-- ── 1. Approving a chip request could not be retried ───────────────────────
--
-- `fn_respond_chip_request` locks the request row FOR UPDATE and refuses
-- anything not 'pending', so a double tap cannot send twice - that part was
-- sound. But for the money move it called
--
--     fn_agent_wallet_send(..., gen_random_uuid())
--
-- a FRESH retry key every time. So when a response was lost on the wire - the
-- one case a retry key exists for - the chips had moved, the request was
-- approved, and the operator's retry was told **"request already approved"**,
-- which the client turns into a red toast. Money moved; the person who moved
-- it was told it had not. That is the worst shape a money screen can take.
--
-- `chip_requests` has carried an `op_id` column, with a unique index on
-- `(club_id, requester_id, op_id)`, since requests themselves were made
-- idempotent - so the retry key was designed into this table and the approval
-- path simply never used one.
--
-- Now: the send's key is derived from the request id, so it is the same key on
-- every attempt, and `fn_agent_wallet_send` replays instead of re-sending. And
-- a retry that arrives after the request is already approved no longer reports
-- a failure: it looks for the chip_transaction written under THAT key and, if
-- it is there, returns the original receipt with `replayed: true`.
--
-- It only claims a replay when it can SEE the transaction. Approvals made
-- before today used a random key, so nothing can be found under the derived
-- one, and those keep the old honest refusal rather than being re-sent - which
-- is the one outcome that would actually move money twice.
--
-- ── 2. A settlement freeze froze nothing ───────────────────────────────────
--
-- `clubs.settlement_locked` is set by an operator declaring a freeze while the
-- books are squared. Measured: the only two functions in the database that
-- read it are `expire_settlement_locks` (the sweep that clears it) and
-- `ca_club_operations_overview` (which displays it). **No money function reads
-- it at all** - not the sends, not the claim-backs, not the batch transfer.
-- `checkSettlementLock` exists in the client, fails open by design, and is
-- called from the classic cashier only; the Trade cashier never checks it.
-- So a declared freeze stopped nothing.
--
-- This is enforced the way the platform already enforces its maintenance
-- freeze (CLAUDE.md 13): a BEFORE INSERT trigger on the money table, not a
-- check bolted into each of the four money functions. That way it cannot be
-- forgotten by a path nobody remembered, and the 191-line defended bodies stay
-- untouched.
--
-- WHAT IT FREEZES, and what it deliberately does not. A settlement freeze is
-- about OPERATOR chip movement while the books are being squared - sends,
-- claim-backs, commission claims, promo pushes, admin removals. It must never
-- stop a game: `fn_atomic_buyin` writes a `mint` row, so freezing mints would
-- refuse buy-ins mid-session. Gameplay types (mint, buyin, cashout, topup,
-- tournament_*, rakeback, horse funding, seat credit) are all excluded, and
-- service_role keeps its escape so the settlement runner itself can still
-- move the chips the freeze exists to protect.
--
-- Nothing is locked today (0 of 4 clubs), so this changes no behaviour on the
-- platform as it stands - it makes the switch real for the first time.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- ─────────────────────────────────────────────────────────────────────────
--  1. Is this club's settlement freeze actually on?
-- ─────────────────────────────────────────────────────────────────────────
-- A lock past its own expiry is not a lock. `expire_settlement_locks` clears
-- them on a schedule, and between runs the column still reads true - so the
-- expiry is honoured here rather than trusting the sweep to have run.
CREATE OR REPLACE FUNCTION public.fn_club_settlement_frozen(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT c.settlement_locked
       AND (c.settlement_lock_until IS NULL OR c.settlement_lock_until > now())
       FROM clubs c WHERE c.id = p_club_id),
    false);
$function$;

COMMENT ON FUNCTION public.fn_club_settlement_frozen(uuid) IS
  'True while this club has declared a settlement freeze that has not expired. Read by the operator-movement guard on chip_transactions and by any surface that wants to say why a transfer will be refused.';

REVOKE ALL ON FUNCTION public.fn_club_settlement_frozen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_settlement_frozen(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  2. The guard: operator movement stops, play does not
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_refuse_operator_move_while_settling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text;
BEGIN
  -- Only operator movement. Everything a TABLE does is excluded on purpose:
  -- fn_atomic_buyin writes 'mint', so a freeze that caught mints would refuse
  -- buy-ins mid-session, and a settlement freeze is not a maintenance break.
  IF NEW.transaction_type IS NULL OR NEW.transaction_type NOT IN (
       'agent_wallet_send', 'agent_wallet_claim_back', 'agent_wallet_self_stake',
       'club_bank_send', 'club_bank_claim', 'club_bank_reversal',
       'promo_wallet_send', 'commission_claim',
       'admin_adjustment', 'admin_removal'
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.club_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The settlement runner and every server-side job move chips as
  -- service_role, and the freeze exists to protect exactly that work.
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF coalesce(auth.role(), '') = 'service_role'
     OR session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF public.fn_club_settlement_frozen(NEW.club_id) THEN
    RAISE EXCEPTION
      'SETTLEMENT_FROZEN: this club is squaring its books. % was refused; it will succeed when the freeze lifts.',
      NEW.transaction_type
      USING ERRCODE = '55006',
            HINT = 'A settlement freeze stops operator transfers, not play. Nothing is lost - retry once the freeze is lifted.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_refuse_operator_move_while_settling() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_settlement_freeze_guard ON public.chip_transactions;
CREATE TRIGGER zz_settlement_freeze_guard
  BEFORE INSERT ON public.chip_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_operator_move_while_settling();

-- ─────────────────────────────────────────────────────────────────────────
--  3. The approval carries a retry key, and a retry tells the truth
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_respond_chip_request(p_request_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_req record;
  v_role text;
  v_send jsonb;
  v_op_id uuid;
  v_prior record;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_action not in ('approve','decline','cancel') then
    return jsonb_build_object('success', false, 'error', 'invalid action');
  end if;

  select * into v_req from chip_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'request not found'); end if;

  -- THE SAME KEY ON EVERY ATTEMPT. Derived from the request, so a retry after
  -- a lost response replays the original send instead of making a new one.
  v_op_id := md5('chip_request_approve:' || p_request_id::text)::uuid;

  if v_req.status <> 'pending' then
    -- A RETRY AFTER A LOST RESPONSE IS NOT A FAILURE. If this caller already
    -- answered this request, say what happened rather than reporting an error
    -- for work that succeeded.
    if v_req.responded_by = v_me then
      if v_req.status = 'approved' then
        -- Only claim a replay against a transaction actually written under
        -- this key. Approvals made before this migration used a random key,
        -- so nothing is found and the honest refusal below stands - re-sending
        -- them is the one outcome that would move money twice.
        select ct.id, ct.amount into v_prior
          from chip_transactions ct
         where ct.club_id = v_req.club_id
           and ct.from_user_id = v_me
           and ct.metadata ->> 'op_id' = v_op_id::text
         limit 1;
        if found then
          return jsonb_build_object('success', true, 'status', 'approved',
                                    'replayed', true, 'transaction_id', v_prior.id,
                                    'amount', v_prior.amount);
        end if;
      else
        return jsonb_build_object('success', true, 'status', v_req.status,
                                  'replayed', true);
      end if;
    end if;
    return jsonb_build_object('success', false, 'error', 'request already ' || v_req.status);
  end if;

  if p_action = 'cancel' then
    if v_req.requester_id <> v_me then
      return jsonb_build_object('success', false, 'error', 'only the requester may cancel');
    end if;
    update chip_requests set status = 'cancelled', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'cancelled');
  end if;

  v_role := public.fn_club_bank_role(v_req.club_id);
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'you cannot answer chip requests here');
  end if;
  if v_role in ('super_agent','agent','sub_agent') and v_req.approver_id is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'this request is not addressed to you');
  end if;

  if p_action = 'decline' then
    update chip_requests set status = 'declined', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'declined');
  end if;

  if v_me = v_req.requester_id then
    return jsonb_build_object('success', false, 'error', 'you cannot approve your own request');
  end if;

  -- Said before the send, so the operator is told WHY rather than reading a
  -- raw trigger message. The guard on chip_transactions is what actually
  -- enforces it; this is the sentence that reaches the screen.
  if public.fn_club_settlement_frozen(v_req.club_id) then
    return jsonb_build_object('success', false,
      'error', 'this club is squaring its books - approvals resume when the settlement freeze lifts');
  end if;

  v_send := public.fn_agent_wallet_send(
    v_req.club_id, v_req.requester_id, v_req.amount,
    'player_wallet', 'Chip Request Approved', v_op_id);
  if not coalesce((v_send ->> 'success')::boolean, false) then
    return jsonb_build_object('success', false,
      'error', coalesce(v_send ->> 'error', 'the send was refused'));
  end if;

  update chip_requests set status = 'approved', responded_by = v_me, responded_at = now()
   where id = p_request_id;

  return jsonb_build_object('success', true, 'status', 'approved',
                            'replayed', coalesce((v_send ->> 'replayed')::boolean, false),
                            'your_balance', (v_send ->> 'agent_wallet_after')::numeric,
                            'their_balance', (v_send ->> 'recipient_balance_after')::numeric);
end $function$;

REVOKE ALL ON FUNCTION public.fn_respond_chip_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_respond_chip_request(uuid, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
--  4. The migration refuses to commit the old shapes
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_respond_chip_request'
     AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%gen_random_uuid()%' THEN
    RAISE EXCEPTION 'approving a chip request still mints a fresh retry key on every attempt';
  END IF;
  IF v_src NOT LIKE '%md5(''chip_request_approve:''%' THEN
    RAISE EXCEPTION 'the approval has no stable retry key';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'zz_settlement_freeze_guard'
       AND tgrelid = 'public.chip_transactions'::regclass
  ) THEN
    RAISE EXCEPTION 'a declared settlement freeze still stops nothing';
  END IF;
  -- The guard must never catch a hand being played. Checked against the
  -- frozen LIST itself, not the whole body - the body names those types in
  -- the comment that explains why they are excluded.
  SELECT substring(prosrc from 'NOT IN \(([^)]*)\)') INTO v_src FROM pg_proc
   WHERE proname = 'fn_refuse_operator_move_while_settling'
     AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the settlement guard no longer names the movement it freezes';
  END IF;
  IF v_src LIKE '%''mint''%' OR v_src LIKE '%''buyin''%' OR v_src LIKE '%''cashout''%'
     OR v_src LIKE '%''topup''%' OR v_src LIKE '%tournament_%' THEN
    RAISE EXCEPTION 'the settlement guard would refuse gameplay, not just operator movement';
  END IF;
  IF v_src NOT LIKE '%''agent_wallet_send''%' OR v_src NOT LIKE '%''club_bank_send''%' THEN
    RAISE EXCEPTION 'the settlement guard does not cover the cashier sends';
  END IF;
END $$;

COMMIT;
