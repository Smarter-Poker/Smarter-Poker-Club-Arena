-- ============================================================================
-- A DIAMOND CORRECTION SETTLES ONCE
-- ============================================================================
--
-- Diamond Arena programme, Phase 10 line 4 ("staff-only game configuration,
-- incident review and audited adjustments"), the audited adjustments: item 7
-- of the ordered build list in docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md.
--
-- What was there (read live 2026-09-29): ca_manual_adjustments, the four-eyes
-- register, already takes a Diamond row - target diamond_wallet or
-- diamond_house, asset diamonds, whole numbers, a reason of at least twenty
-- characters, and a CHECK that the approver is never the proposer. An
-- approved Diamond row had nowhere to go: the register's one settler,
-- fn_settle_tournament_obligation_before_atomic_batch_gate, takes chips to a
-- player wallet only. The register's own propose, approve and reject are
-- service-role only, admit any "management" caller (an incident recipient, a
-- club or union owner, admin or god) and take the actor from the caller.
--
-- What this adds:
--
--   1. ca_diamond_correction_source - what pays for a Diamond correction.
--      One row or none, written by a values migration that quotes Dan, never
--      by code (the audit's decision 2). This migration writes no row; until
--      one exists every settlement is refused by name
--      (diamond_correction_source_not_authorized). The two answers:
--        diamond_house - the house pays a player credit and takes a player
--                        debit: a house burn and a player mint on the
--                        register (a debit: a player burn and a house mint),
--                        the pair the Phase 8 fee settlement and the Phase 9
--                        Spin reserve already use, so supply does not move.
--                        The house holds 0 today; a credit it cannot cover
--                        is refused by name (that_would_take_the_house_below_zero).
--        new_issuance  - a player credit is minted to the player and a debit
--                        retired from the player, each in the register.
--      A house row (target diamond_house) has no counterparty but the
--      register under either answer: its credit mints into the house and its
--      debit retires from it. Under diamond_house that is how the house is
--      funded: by an approved row, like any other correction.
--   2. ca_diamond_adjustment_receipts - one immutable receipt per settled
--      Diamond adjustment, keyed by the adjustment, so a second settlement
--      cannot exist.
--   3. fn_ca_diamond_adjustment_settle(uuid) - the one platform-staff door
--      that settles an APPROVED Diamond row, exactly once. Every leg goes
--      through the Mint's own doors, fn_ca_mint and fn_ca_burn, as the
--      signed-in staff member: they move the balance, write the journal
--      (diamond_transactions for a player; the register is the record of a
--      house leg, as for every house movement since Phase 8), write the
--      register (ca_mint_ledger), hold the mint policy's caps and the
--      issuance freeze, and are writers DR6 admits by name. The legs, the
--      receipt and the settled status happen in one sub-transaction: a leg
--      the Mint refuses rolls all of it back and its refusal is returned by
--      name, the row still approved. A replay returns the stored receipt and
--      moves nothing.
--   4. fn_ca_diamond_adjustment_propose / _approve / _reject - platform-staff
--      doors over the register's own three functions. Each admits only
--      fn_is_platform_admin(), only a Diamond row, and names the signed-in
--      caller as the actor, approver or rejecter; nothing the caller sends
--      can name anyone else. The register's CHECK (an approver is never the
--      proposer) is the second-person rule and is unchanged (the audit's
--      decision 3); ca_operator_policy is neither read nor written.
--
-- No existing function, constraint, grant, policy or switch changes.
-- tournaments_enabled and cash_games_enabled stay false. No number is
-- invented: the only caps are the mint policy's own.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)) - called, not changed:
--   fn_ca_propose_manual_adjustment   da73a86110bccc223923e61fc67f12c8
--   fn_ca_approve_manual_adjustment   87c480eddf6aa3f9b0c0a6c51b9b78ef
--   fn_ca_reject_manual_adjustment    7e9450272c980feb7681144696d75c42
--   fn_ca_mint                        da9429ce6483c47c7d536582433a1edd
--   fn_ca_burn                        01892d172b17e45bc8a47f76d3e5a564
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond Arena switch is already on somewhere; this migration expects both closed';
  END IF;
  IF to_regclass('public.ca_diamond_correction_source') IS NOT NULL
     OR to_regclass('public.ca_diamond_adjustment_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'the Diamond correction tables already exist; this migration creates them';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_propose_manual_adjustment(text,numeric,text,uuid,uuid,uuid,text,text)', 'da73a86110bccc223923e61fc67f12c8'),
      ('public.fn_ca_approve_manual_adjustment(uuid,uuid,text,text)', '87c480eddf6aa3f9b0c0a6c51b9b78ef'),
      ('public.fn_ca_reject_manual_adjustment(uuid,text,uuid,text)', '7e9450272c980feb7681144696d75c42'),
      ('public.fn_ca_mint(text,text,uuid,numeric,text,text,text)', 'da9429ce6483c47c7d536582433a1edd'),
      ('public.fn_ca_burn(text,text,uuid,numeric,text,text,text)', '01892d172b17e45bc8a47f76d3e5a564')
    ) AS p(sig, pin)
  LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', r.sig, md5(pg_get_functiondef(r.sig::regprocedure));
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. WHAT PAYS FOR A DIAMOND CORRECTION IS AUTHORIZED, NEVER ASSUMED
-- ---------------------------------------------------------------------------
CREATE TABLE public.ca_diamond_correction_source (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source text NOT NULL CHECK (source IN ('diamond_house', 'new_issuance')),
  authorized_by text NOT NULL CHECK (length(btrim(authorized_by)) >= 2),
  ruling text NOT NULL CHECK (length(btrim(ruling)) >= 10),
  authorized_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_diamond_correction_source IS
  'WHAT PAYS FOR A DIAMOND CORRECTION (Diamond Phase 10). One row or none, written by a values migration that quotes Dan, never by code. '
  'diamond_house: the house pays a player credit and takes a player debit (a house burn and a player mint on the register, or a player '
  'burn and a house mint). new_issuance: a player credit is minted to the player and a debit retired from the player. A house row moves '
  'against the register under either. No row: fn_ca_diamond_adjustment_settle refuses every settlement '
  '(diamond_correction_source_not_authorized). CLAUDE.md 10.9: the answer is Dan''s.';
ALTER TABLE public.ca_diamond_correction_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_correction_source FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_correction_source TO service_role;

-- ---------------------------------------------------------------------------
-- 2. A SETTLED DIAMOND ADJUSTMENT HAS ONE RECEIPT, AND IT NEVER CHANGES
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_diamond_adjustment_receipt_is_immutable', 'system',
   'Diamond Phase 10. Trigger: a Diamond adjustment receipt is never updated or deleted. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_receipt_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'A Diamond adjustment receipt is immutable' USING ERRCODE = '23514';
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_adjustment_receipt_is_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.ca_diamond_adjustment_receipts (
  adjustment_id uuid PRIMARY KEY REFERENCES public.ca_manual_adjustments (id),
  target_kind text NOT NULL CHECK (target_kind IN ('diamond_wallet', 'diamond_house')),
  target_id uuid,
  amount numeric NOT NULL CHECK (amount <> 0 AND amount = round(amount, 0)),
  source text NOT NULL CHECK (source IN ('diamond_house', 'new_issuance')),
  settled_by uuid NOT NULL,
  settled_by_label text,
  settled_at timestamptz NOT NULL DEFAULT now(),
  receipt jsonb NOT NULL
);
COMMENT ON TABLE public.ca_diamond_adjustment_receipts IS
  'DIAMOND ADJUSTMENT RECEIPTS (Diamond Phase 10). One row per settled diamond_wallet or diamond_house row of ca_manual_adjustments, '
  'written only by fn_ca_diamond_adjustment_settle in the same sub-transaction as the legs and the settled status; the key makes a '
  'second settlement impossible and a replay returns this receipt. Immutable. amount is signed as the adjustment holds it; source is '
  'what paid (ca_diamond_correction_source at the time); receipt carries the Mint''s own answer for every leg.';
ALTER TABLE public.ca_diamond_adjustment_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_adjustment_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_adjustment_receipts TO service_role;
CREATE TRIGGER trg_ca_diamond_adjustment_receipt_is_immutable
  BEFORE UPDATE OR DELETE ON public.ca_diamond_adjustment_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_adjustment_receipt_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. AN APPROVED DIAMOND ADJUSTMENT SETTLES ONCE, THROUGH THE MINT'S OWN DOORS
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_diamond_adjustment_settle', 'approved',
   'Diamond Phase 10. The one door that settles an approved diamond_wallet or diamond_house row of ca_manual_adjustments, exactly once. '
   'Platform staff only (fn_is_platform_admin). Refused by name until ca_diamond_correction_source says what pays: diamond_house (a house '
   'burn and a player mint on the register, or a player burn and a house mint) or new_issuance (a mint to or a retirement from the '
   'target); a house row moves against the register under either. Every leg through fn_ca_mint / fn_ca_burn as the signed-in staff '
   'member, so the balance, the journal and the register move together under the mint policy and the issuance freeze. One immutable '
   'receipt per adjustment (ca_diamond_adjustment_receipts) and the row marked settled in the same sub-transaction; a Mint refusal rolls '
   'every leg back and is returned by name; a replay returns the stored receipt and moves nothing.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_settle(p_adjustment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house   constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_uid     uuid := auth.uid();
  v_label   text;
  v_adj     public.ca_manual_adjustments%ROWTYPE;
  v_src     public.ca_diamond_correction_source%ROWTYPE;
  v_prior   public.ca_diamond_adjustment_receipts%ROWTYPE;
  v_n       numeric;
  v_credit  boolean;
  v_player  boolean;
  v_reason  text;
  v_plan    text[];
  v_step    text;
  v_holder  text;
  v_key     text;
  v_leg     jsonb;
  v_legs    jsonb := '[]'::jsonb;
  v_moved   numeric := 0;
  v_refusal jsonb;
  v_receipt jsonb;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;

  SELECT * INTO v_adj FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_adj.asset IS DISTINCT FROM 'diamonds' OR v_adj.target_kind NOT IN ('diamond_wallet', 'diamond_house') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_adj.asset, 'target_kind', v_adj.target_kind);
  END IF;

  -- EXACTLY ONCE. The row is locked, so a second caller waits here and then
  -- reads what the first committed: a replay moves nothing and answers what
  -- the settlement answered.
  IF v_adj.status = 'settled' THEN
    SELECT * INTO v_prior FROM public.ca_diamond_adjustment_receipts WHERE adjustment_id = v_adj.id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'refused_reason', 'settled_without_a_receipt',
        'adjustment_id', p_adjustment_id);
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replayed', true);
  END IF;
  IF v_adj.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_approved',
      'adjustment_id', p_adjustment_id, 'status', v_adj.status);
  END IF;

  -- WHAT PAYS IS DAN'S (decision 2). No row: nothing moves.
  SELECT * INTO v_src FROM public.ca_diamond_correction_source WHERE id = 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamond_correction_source_not_authorized',
      'adjustment_id', p_adjustment_id);
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  v_n      := abs(v_adj.amount);
  v_credit := v_adj.amount > 0;
  v_player := v_adj.target_kind = 'diamond_wallet';
  -- Each step is <mint|burn>:<player|house>, in the order the Mint runs them.
  -- A house row has no counterparty but the register, whatever pays.
  v_plan := CASE
    WHEN v_player AND v_src.source = 'diamond_house' AND v_credit THEN ARRAY['burn:house', 'mint:player']
    WHEN v_player AND v_src.source = 'diamond_house' THEN ARRAY['burn:player', 'mint:house']
    WHEN v_player AND v_credit THEN ARRAY['mint:player']
    WHEN v_player THEN ARRAY['burn:player']
    WHEN v_credit THEN ARRAY['mint:house']
    ELSE ARRAY['burn:house']
  END;
  v_reason := format('Diamond adjustment %s (proposed by %s, approved by %s): %s',
                     v_adj.id, COALESCE(v_adj.actor_label, v_adj.actor::text),
                     COALESCE(v_adj.approver_label, v_adj.approver::text), v_adj.reason);

  BEGIN
    FOREACH v_step IN ARRAY v_plan LOOP
      v_holder := split_part(v_step, ':', 2);
      v_key    := 'diamond-adjustment:' || v_adj.id::text || ':' || v_step;
      IF split_part(v_step, ':', 1) = 'mint' THEN
        v_leg := public.fn_ca_mint('diamonds', v_holder,
                   CASE WHEN v_holder = 'house' THEN c_house ELSE v_adj.target_id END,
                   v_n, v_reason, v_key, 'admin');
      ELSE
        v_leg := public.fn_ca_burn('diamonds', v_holder,
                   CASE WHEN v_holder = 'house' THEN c_house ELSE v_adj.target_id END,
                   v_n, v_reason, v_key, 'admin');
      END IF;
      IF COALESCE((v_leg ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_refusal := jsonb_build_object('ok', false,
          'refused_reason', COALESCE(v_leg ->> 'reason', 'the_mint_refused'),
          'adjustment_id', p_adjustment_id, 'status', 'approved', 'source', v_src.source,
          'leg', v_step, 'mint_answer', v_leg);
        RAISE EXCEPTION 'a Diamond adjustment leg was refused' USING ERRCODE = 'P0961';
      END IF;
      IF COALESCE((v_leg ->> 'replayed')::boolean, false) THEN
        RAISE EXCEPTION 'Diamond adjustment %: the Mint had already answered op id %; refusing to record a settlement this door did not make',
          v_adj.id, v_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                      WHERE m.op_id = v_key AND m.asset = 'diamonds' AND m.amount = v_n
                        AND m.action = split_part(v_step, ':', 1) AND m.holder_type = v_holder) THEN
        RAISE EXCEPTION 'Diamond adjustment %: the register does not carry leg %', v_adj.id, v_step;
      END IF;
      v_moved := v_moved + CASE WHEN split_part(v_step, ':', 1) = 'mint' THEN v_n ELSE -v_n END;
      v_legs  := v_legs || jsonb_build_array(v_leg);
    END LOOP;

    v_receipt := jsonb_build_object(
      'ok', true, 'replayed', false, 'adjustment_id', v_adj.id, 'status', 'settled',
      'asset', 'diamonds', 'target_kind', v_adj.target_kind, 'target_id', v_adj.target_id,
      'amount', v_adj.amount, 'direction', CASE WHEN v_credit THEN 'credit' ELSE 'debit' END,
      'source', v_src.source, 'supply_moved', v_moved, 'legs', v_legs, 'reason', v_adj.reason,
      'proposed_by', v_adj.actor, 'proposed_by_label', v_adj.actor_label,
      'approved_by', v_adj.approver, 'approved_by_label', v_adj.approver_label,
      'approved_at', v_adj.approved_at,
      'settled_by', v_uid, 'settled_by_label', v_label, 'settled_at', now());
    INSERT INTO public.ca_diamond_adjustment_receipts
      (adjustment_id, target_kind, target_id, amount, source, settled_by, settled_by_label, receipt)
    VALUES
      (v_adj.id, v_adj.target_kind, v_adj.target_id, v_adj.amount, v_src.source, v_uid, v_label, v_receipt);
    UPDATE public.ca_manual_adjustments SET status = 'settled'
     WHERE id = v_adj.id AND status = 'approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diamond adjustment %: the approved row could not be marked settled', v_adj.id;
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0961' THEN
    IF v_refusal IS NULL THEN
      RAISE;
    END IF;
    RETURN v_refusal;
  END;
  RETURN v_receipt;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_adjustment_settle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_adjustment_settle(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. PLATFORM STAFF PROPOSE, APPROVE AND REJECT A DIAMOND ADJUSTMENT AS THEMSELVES
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_diamond_adjustment_propose', 'approved',
   'Diamond Phase 10. Platform-staff door over fn_ca_propose_manual_adjustment: a diamond_wallet row for an existing player or a '
   'diamond_house row (the house sentinel), the signed-in caller always the actor. Moves no money.'),
  ('fn_ca_diamond_adjustment_approve', 'approved',
   'Diamond Phase 10. Platform-staff door over fn_ca_approve_manual_adjustment for a Diamond row, the signed-in caller always the '
   'approver, so the register''s CHECK (an approver is never the proposer) is the second-person rule. Moves no money.'),
  ('fn_ca_diamond_adjustment_reject', 'approved',
   'Diamond Phase 10. Platform-staff door over fn_ca_reject_manual_adjustment for a Diamond row, the signed-in caller always the '
   'rejecter. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_propose(p_target_kind text, p_target_id uuid, p_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_uid   uuid := auth.uid();
  v_kind  text := lower(btrim(COALESCE(p_target_kind, '')));
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  IF v_kind NOT IN ('diamond_wallet', 'diamond_house') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_target', 'target_kind', v_kind);
  END IF;
  IF v_kind = 'diamond_wallet'
     AND (p_target_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_target_id)) THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'player_not_found', 'target_id', p_target_id);
  END IF;
  IF v_kind = 'diamond_house' AND p_target_id IS NOT NULL AND p_target_id <> c_house THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'the_house_target_is_the_house_sentinel_or_null',
      'target_id', p_target_id);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_propose_manual_adjustment(
           p_reason, p_amount, v_kind,
           CASE WHEN v_kind = 'diamond_house' THEN c_house ELSE p_target_id END,
           NULL, v_uid, v_label, 'diamonds');
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_adjustment_propose(text, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_adjustment_propose(text, uuid, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_approve(p_adjustment_id uuid, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_asset text;
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  SELECT a.asset INTO v_asset FROM public.ca_manual_adjustments a WHERE a.id = p_adjustment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_asset IS DISTINCT FROM 'diamonds' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_asset);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_approve_manual_adjustment(p_adjustment_id, v_uid, v_label, p_note);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_adjustment_approve(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_adjustment_approve(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_adjustment_reject(p_adjustment_id uuid, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_asset text;
  v_label text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'platform_staff_only');
  END IF;
  SELECT a.asset INTO v_asset FROM public.ca_manual_adjustments a WHERE a.id = p_adjustment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_adjustment_id);
  END IF;
  IF v_asset IS DISTINCT FROM 'diamonds' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_a_diamond_adjustment',
      'adjustment_id', p_adjustment_id, 'asset', v_asset);
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) INTO v_label
    FROM public.profiles p WHERE p.id = v_uid;
  RETURN public.fn_ca_reject_manual_adjustment(p_adjustment_id, p_note, v_uid, v_label);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_adjustment_reject(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_adjustment_reject(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_bad text; v_n integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_diamond_correction_source) THEN
    RAISE EXCEPTION 'this migration must not authorize what pays for a Diamond correction';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_adjustment_receipts) THEN
    RAISE EXCEPTION 'this migration must not settle anything';
  END IF;
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, pg_get_functiondef(p.oid) AS d
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_diamond_adjustment_propose', 'fn_ca_diamond_adjustment_approve',
                                'fn_ca_diamond_adjustment_reject', 'fn_ca_diamond_adjustment_settle')
  LOOP
    v_n := v_n + 1;
    IF NOT r.prosecdef OR position('IF NOT public.fn_is_platform_admin() THEN' IN r.d) = 0 THEN
      RAISE EXCEPTION '% is not a platform-staff door', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% cannot be reached by a signed-in staff member', r.proname;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = r.proname AND g.status = 'approved') THEN
      RAISE EXCEPTION '% is not registered', r.proname;
    END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'expected the four Diamond adjustment doors, found %', v_n;
  END IF;
  FOR r IN SELECT p.oid, p.proname
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_mint', 'fn_ca_burn', 'fn_ca_propose_manual_adjustment',
                                'fn_ca_approve_manual_adjustment', 'fn_ca_reject_manual_adjustment',
                                'fn_ca_diamond_adjustment_receipt_is_immutable')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable by a client role', r.proname;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.ca_diamond_correction_source', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_diamond_correction_source', 'SELECT')
     OR has_table_privilege('service_role', 'public.ca_diamond_correction_source', 'INSERT')
     OR has_table_privilege('anon', 'public.ca_diamond_adjustment_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ca_diamond_adjustment_receipts', 'SELECT')
     OR has_table_privilege('service_role', 'public.ca_diamond_adjustment_receipts', 'INSERT') THEN
    RAISE EXCEPTION 'a Diamond correction table has a key it should not';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a Diamond correction settles once: four platform-staff doors, one receipt per adjustment, every leg through the Mint, nothing authorized, nothing opened';
END $m$;
