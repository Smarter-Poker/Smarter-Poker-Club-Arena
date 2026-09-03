-- ============================================================================
--  TWO ORPHAN MONEY DOORS ARE CLOSED, AND EVERY MANUAL MOVEMENT IS ON A REPORT
--
--  Chip Accounting Standard, Phase 2, lane 2.5 (F9 doors closed, F10 report in
--  advisory form). Audit: docs/audits/2026-09-02-chip-standard-round2/
--  lane2-hierarchy.md sections 2.2 (C2d, C2e, U3a, U3b, U7, M5, C4) and 3.1.
--
--  WHAT WAS WRONG (F9). The audit named seven RPCs that move chips and are
--  still EXECUTE-granted although nothing calls them. Re-verified on
--  2026-09-03 against the live grants, a grep of club-arena src/, server/src/,
--  supabase/functions/ and World Hub pages/api, src/, lib/, the bodies of
--  every other function in pg_proc, pg_cron, and thirty days of ledger rows:
--
--    fn_wallet_claim_back          authenticated + service_role, ZERO callers
--                                  anywhere, zero club_bank_claim / agent_claim
--                                  / promo_claim rows in 30 days. An agent
--                                  could pull ANY amount from ANY downline
--                                  player's wallet with no window, no consent
--                                  and no notification - the exact thing the
--                                  ten minute rule in fn_agent_wallet_claim_back
--                                  forbids. CLOSED HERE.
--    fn_union_send_chips_to_club   service_role only, ZERO callers (two code
--                                  comments name it), zero send_to_club rows
--                                  in 30 days. Pays a union distribution into
--                                  the club OWNER's player wallet instead of
--                                  the club bank. CLOSED HERE.
--    fn_cashier_claim_back         service_role only, no caller since #871
--                                  (2026-08-25), but ONE 1.00-chip call on
--                                  2026-08-21 inside the 30 day window. The
--                                  lane rule is "a call in 30 days means do not
--                                  touch"; eligible from 2026-09-21. NOT
--                                  TOUCHED.
--    fn_union_send_to_club_atomic  LIVE caller: World Hub union-wallet.js
--                                  (service_role). NOT TOUCHED.
--    fn_union_deposit_from_wallet  LIVE caller: src/pages/UnionDashboardPage
--                                  (browser, authenticated). NOT TOUCHED.
--    mint_club_chips               World Hub mint-chips.js still carries the
--                                  call in a block marked unreachable; already
--                                  service_role only. NOT TOUCHED.
--    calculate_cascading_commission LIVE callers: settle_hand_atomically (in
--                                  the database), World Hub record-rake.js and
--                                  LobbyManager.js, src/services/
--                                  CommissionService.ts. Its anon EXECUTE is
--                                  reported, not revoked. NOT TOUCHED.
--
--  THE RULE (F9). A money door nothing calls is not left open on the chance
--  someone finds it. It is revoked from every client role AND from
--  service_role, registered as `closed` in ca_money_rpc_registry, and the
--  daily fn_ca_money_rpc_drift raises an incident if a closed door is ever
--  executable again. Nothing is dropped: the roadmap drops after one clean
--  week, and a revoke is reversible in one statement if a caller surfaces.
--
--  WHAT WAS WRONG (F10). No four-eyes or threshold exists anywhere in the
--  hierarchy: over the 7 days to 2026-09-03 there were two club_bank_send
--  rows of 3,750,000 each, thirty agent_wallet_send rows above 100,000 (max
--  600,000), 13 opening grants of 100,000, and 308 ca_mint_ledger rows with
--  performed_by NULL - all single actor. Dan has not yet set the threshold
--  (roadmap decision 6), so this file builds ONLY the read side.
--
--  THE RULE (F10, advisory). fn_ca_adjustments_report(p_since) lists every
--  actor-initiated movement above zero through the hierarchy doors, mints,
--  clawbacks and corrections since p_since, one row per ledger row, with the
--  actor, the accounts and entities on both sides, the amount, the club and
--  union, the reference (op id / idempotency key / settlement id / row id) and
--  a single_actor flag that is true unless an APPROVED ca_manual_adjustments
--  row by a different person matches the reference, the adjustment_id in the
--  metadata, or the target and amount within seven days. It blocks nothing,
--  schedules nothing and moves nothing. SECURITY DEFINER, service_role only,
--  plus the management gate fn_ca_post_correction uses for a JWT caller.
--
--  Sources and their inclusion filters (all amount > 0):
--    chip_transactions          the manual hierarchy types only (sends,
--                               claims, grants, mints, corrections, treasury
--                               credits/debits, union transfers and P&L);
--                               never cashout, buy-ins, rake, sweeps.
--    union_wallet_transactions  manual types only (manual_transfer,
--                               send_to_club, owner_deposit, adjustment,
--                               clawback, rakeback, spin_reserve_seed, P&L).
--    ca_mint_ledger             every row.
--    chip_ledger                mint, club_bank_send, club_bank_claim,
--                               agent_send, agent_claim, union_settlement,
--                               union_send, correction, reversal, and
--                               adjustment when it is NOT an auto-audited /
--                               auto-ledgered trigger row (those are 148,000
--                               rows a week of table activity, not actors).
--  The same movement can appear from two sources (a club_bank_send is a
--  chip_transactions row and a chip_ledger row); the `source` column keeps
--  them apart and the report is a list, not a sum.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. F9: revoke the two confirmed-dead doors from every role, PUBLIC included.
--    Nothing calls either, so service_role goes too.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_wallet_claim_back(uuid, uuid, numeric, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_union_send_chips_to_club(uuid, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The registry learns the word `closed`. The column already exists
--    (status text default 'approved', CHECK approved/legacy/retired/system);
--    only its CHECK is widened, no row's existing value changes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_money_rpc_registry
  DROP CONSTRAINT IF EXISTS ca_money_rpc_registry_status_check;
ALTER TABLE public.ca_money_rpc_registry
  ADD CONSTRAINT ca_money_rpc_registry_status_check
  CHECK (status = ANY (ARRAY['approved'::text, 'legacy'::text, 'retired'::text, 'system'::text, 'closed'::text]));

UPDATE public.ca_money_rpc_registry
   SET status = 'closed',
       notes = COALESCE(notes, '')
            || ' | CLOSED 2026-09-03 chip-std phase 2 lane 2.5 (F9): zero callers in club-arena, World Hub, pg_proc, pg_cron; zero ledger rows in 30 days; EXECUTE revoked from PUBLIC, anon, authenticated, service_role. Drop after one clean week.'
 WHERE proname IN ('fn_wallet_claim_back', 'fn_union_send_chips_to_club');

-- ---------------------------------------------------------------------------
-- 3. fn_ca_money_rpc_drift: the existing body, byte for byte, plus one loop -
--    a registry row marked `closed` whose function is executable by anon,
--    authenticated or service_role raises an incident and is returned, which
--    also fails fn_ca_epoch3_preflight and fn_ca_midway_burnin_gate (both
--    count this function's rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
 RETURNS TABLE(proname text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_cols text[];
  v_col_re text;
BEGIN
  /* The balance columns, read from the triggers that watch them. */
  SELECT array_agg(DISTINCT c) INTO v_cols
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;

  v_col_re := '\y(' || array_to_string(v_cols, '|') || ')\y';

  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND (
        p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
        OR p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y'
      )
      /* ...and it has to actually name a balance column. */
      AND p.prosrc ~* v_col_re
      AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-drift:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NEW unregistered function writes balance columns: ' || r.pn
        || ' - audit it, then register it in ca_money_rpc_registry',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;

  /* Phase 2 lane 2.5 (F9): a door the registry says is CLOSED must stay
     closed. If any client role - or service_role - can execute it again,
     that is drift of the authorization surface, not of a balance. */
  FOR r IN
    SELECT g.proname AS pn
      FROM public.ca_money_rpc_registry g
      JOIN pg_proc p ON p.proname = g.proname
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE g.status = 'closed'
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-closed-door-open:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'CLOSED money door is executable again: ' || r.pn
        || ' - it was revoked from every client role; revoke it again or change its registry status',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;
END $function$;

-- ---------------------------------------------------------------------------
-- 4. F10 read side: the adjustments report. Advisory. Blocks nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_adjustments_report(
  p_since timestamptz DEFAULT now() - interval '1 day'
)
 RETURNS TABLE(
   source        text,
   moved_at      timestamptz,
   actor         uuid,
   action        text,
   from_account  text,
   from_entity   uuid,
   to_account    text,
   to_entity     uuid,
   amount        numeric,
   club_id       uuid,
   union_id      uuid,
   reference     text,
   single_actor  boolean,
   row_id        uuid
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid  uuid := auth.uid();
  v_mgmt boolean := false;
BEGIN
  /* The management gate fn_ca_post_correction uses. A server-side caller
     (service_role, or no JWT at all: pg_cron, the MCP as postgres) passes;
     a JWT caller must be an active incident recipient or an admin/god. */
  IF v_uid IS NOT NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN
      RAISE EXCEPTION 'management_only' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH m AS (
    SELECT 'chip_transactions'::text AS source,
           ct.created_at AS moved_at,
           COALESCE(
             CASE WHEN length(ct.metadata->>'performed_by') = 36 AND ct.metadata->>'performed_by' ~ '^[0-9a-fA-F-]+$'
                  THEN (ct.metadata->>'performed_by')::uuid END,
             CASE WHEN length(ct.metadata->>'actor_id') = 36 AND ct.metadata->>'actor_id' ~ '^[0-9a-fA-F-]+$'
                  THEN (ct.metadata->>'actor_id')::uuid END,
             CASE WHEN length(ct.metadata->>'minted_by') = 36 AND ct.metadata->>'minted_by' ~ '^[0-9a-fA-F-]+$'
                  THEN (ct.metadata->>'minted_by')::uuid END,
             CASE WHEN ct.transaction_type ~ '(claim|clawback|reversal|collect|removal|debit)'
                  THEN ct.to_user_id ELSE ct.from_user_id END,
             CASE WHEN length(ct.metadata->>'club_owner_id') = 36 AND ct.metadata->>'club_owner_id' ~ '^[0-9a-fA-F-]+$'
                  THEN (ct.metadata->>'club_owner_id')::uuid END
           ) AS actor,
           ct.transaction_type AS action,
           COALESCE(ct.metadata->>'source_wallet',
                    CASE WHEN ct.transaction_type IN ('club_bank_send','treasury_debit') THEN 'club_bank'
                         WHEN ct.transaction_type IN ('agent_wallet_send','agent_wallet_self_stake') THEN 'agent_wallet'
                         WHEN ct.transaction_type IN ('union_transfer','treasury_credit','union_pnl_payout') THEN 'union_bank'
                         WHEN ct.transaction_type IN ('treasury_mint','mint','club_opening_grant','chip_purchase','bonus','chip_credit','admin_adjustment') THEN 'issuance'
                         WHEN ct.from_user_id IS NOT NULL THEN 'member_wallet'
                         ELSE 'club_treasury' END) AS from_account,
           ct.from_user_id AS from_entity,
           COALESCE(ct.metadata->>'destination', ct.metadata->>'target_wallet',
                    CASE WHEN ct.transaction_type IN ('club_bank_claim','club_bank_reversal','treasury_mint','mint','club_opening_grant','union_transfer','treasury_credit') THEN 'club_bank'
                         WHEN ct.transaction_type IN ('agent_claim','agent_wallet_claim','agent_wallet_claim_back') THEN 'agent_wallet'
                         WHEN ct.transaction_type = 'union_pnl_collect' THEN 'union_bank'
                         WHEN ct.to_user_id IS NOT NULL THEN 'member_wallet'
                         ELSE 'club_treasury' END) AS to_account,
           ct.to_user_id AS to_entity,
           ct.amount,
           ct.club_id,
           COALESCE(CASE WHEN length(ct.metadata->>'union_id') = 36 AND ct.metadata->>'union_id' ~ '^[0-9a-fA-F-]+$'
                         THEN (ct.metadata->>'union_id')::uuid END, c.union_id) AS union_id,
           COALESCE(ct.metadata->>'op_id', ct.metadata->>'idempotency_key', ct.metadata->>'settlement_id', ct.id::text) AS reference,
           COALESCE(ct.metadata, '{}'::jsonb) AS metadata,
           ct.id AS row_id
      FROM public.chip_transactions ct
      LEFT JOIN public.clubs c ON c.id = ct.club_id
     WHERE ct.created_at >= p_since
       AND ct.amount > 0
       AND ct.transaction_type IN (
         'club_bank_send','club_bank_claim','club_bank_reversal',
         'agent_wallet_send','agent_wallet_claim','agent_wallet_claim_back','agent_claim','agent_send',
         'promo_send','promo_claim','agent_wallet_self_stake',
         'club_opening_grant','treasury_mint','mint','treasury_credit','treasury_debit',
         'admin_adjustment','admin_removal','chip_credit','chip_debit',
         'union_transfer','union_pnl_collect','union_pnl_payout',
         'default_mint_correction','clawback','union_clawback','promo_closed_on_union_join',
         'peer_transfer','chip_purchase','bonus','correction','reversal','adjustment')
    UNION ALL
    SELECT 'union_wallet_transactions',
           u.created_at,
           u.created_by,
           u.tx_type || '/' || u.direction,
           CASE WHEN u.direction = 'debit' THEN 'union_' || u.wallet ELSE COALESCE(u.tx_type, 'external') END,
           CASE WHEN u.direction = 'debit' THEN u.union_id ELSE u.club_id END,
           CASE WHEN u.direction = 'credit' THEN 'union_' || u.wallet ELSE COALESCE(u.tx_type, 'external') END,
           CASE WHEN u.direction = 'credit' THEN u.union_id ELSE u.club_id END,
           u.amount,
           u.club_id,
           u.union_id,
           COALESCE(u.period_id::text, u.id::text),
           '{}'::jsonb,
           u.id
      FROM public.union_wallet_transactions u
     WHERE u.created_at >= p_since
       AND u.amount > 0
       AND u.tx_type IN (
         'manual_transfer','send_to_club','owner_deposit','adjustment','clawback','union_clawback',
         'settlement','statement_paid','rakeback','spin_reserve_seed','player_pnl_pay','player_pnl_collect',
         'correction','reversal','mint','burn')
    UNION ALL
    SELECT 'ca_mint_ledger',
           ml.created_at,
           ml.performed_by,
           ml.action || '/' || ml.asset,
           CASE WHEN ml.action = 'mint' THEN 'issuance_reserve' ELSE ml.holder_type END,
           CASE WHEN ml.action = 'mint' THEN NULL ELSE ml.holder_id END,
           CASE WHEN ml.action = 'mint' THEN ml.holder_type ELSE 'issuance_reserve' END,
           CASE WHEN ml.action = 'mint' THEN ml.holder_id ELSE NULL END,
           ml.amount,
           NULL::uuid,
           NULL::uuid,
           COALESCE(ml.op_id, ml.id::text),
           '{}'::jsonb,
           ml.id
      FROM public.ca_mint_ledger ml
     WHERE ml.created_at >= p_since
       AND ml.amount > 0
    UNION ALL
    SELECT 'chip_ledger',
           l.created_at,
           l.performed_by,
           l.category,
           l.from_type,
           l.from_entity_id,
           l.to_type,
           l.to_entity_id,
           l.amount,
           l.club_id,
           l.union_id,
           COALESCE(l.idempotency_key, l.correlation_id::text, l.id::text),
           COALESCE(l.metadata, '{}'::jsonb),
           l.id
      FROM public.chip_ledger l
     WHERE l.created_at >= p_since
       AND l.amount > 0
       AND (
         l.category IN ('mint','club_bank_send','club_bank_claim','agent_send','agent_claim',
                        'union_settlement','union_send','correction','reversal')
         OR (l.category = 'adjustment' AND COALESCE(l.description, '') NOT LIKE 'auto-%')
       )
  )
  SELECT m.source,
         m.moved_at,
         m.actor,
         m.action,
         m.from_account,
         m.from_entity,
         m.to_account,
         m.to_entity,
         m.amount,
         m.club_id,
         m.union_id,
         m.reference,
         NOT EXISTS (
           SELECT 1
             FROM public.ca_manual_adjustments a
            WHERE a.status = 'approved'
              AND a.approver IS NOT NULL
              AND a.approver IS DISTINCT FROM m.actor
              AND (
                a.id::text = m.reference
                OR a.id::text = m.metadata->>'adjustment_id'
                OR (a.target_id IN (m.from_entity, m.to_entity, m.club_id, m.union_id)
                    AND a.amount = m.amount
                    AND a.approved_at BETWEEN m.moved_at - interval '7 days' AND m.moved_at + interval '1 hour')
              )
         ) AS single_actor,
         m.row_id
    FROM m
   ORDER BY m.amount DESC, m.moved_at DESC;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_adjustments_report(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_adjustments_report(timestamptz) TO service_role;

COMMENT ON FUNCTION public.fn_ca_adjustments_report(timestamptz) IS
  'Chip-std phase 2 lane 2.5 (F10, advisory): every actor-initiated hierarchy movement, mint, clawback and correction since p_since, with a single_actor flag. Read side only - no threshold is enforced until Dan sets one (roadmap decision 6). service_role only, plus the fn_ca_post_correction management gate for a JWT caller.';

-- ---------------------------------------------------------------------------
-- 5. Self-check: the live state must show every change or the whole file
--    rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_oid oid;
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['fn_wallet_claim_back', 'fn_union_send_chips_to_club'] LOOP
    SELECT p.oid INTO v_oid FROM pg_proc p
     WHERE p.proname = v_fn AND p.pronamespace = 'public'::regnamespace;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '% is gone - this file revokes, it does not drop', v_fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is still executable by a client role or service_role', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_fn AND g.status = 'closed') THEN
      RAISE EXCEPTION '% is not registered as closed', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'fn_ca_money_rpc_drift'
                   AND p.pronamespace = 'public'::regnamespace
                   AND p.prosrc LIKE '%rpc-closed-door-open:%'
                   AND p.prosrc LIKE '%rpc-drift:%') THEN
    RAISE EXCEPTION 'fn_ca_money_rpc_drift does not carry both the unregistered-writer scan and the closed-door scan';
  END IF;

  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.proname = 'fn_ca_adjustments_report' AND p.pronamespace = 'public'::regnamespace;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_adjustments_report was not created';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_adjustments_report must not be executable by a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_ca_adjustments_report must be executable by service_role';
  END IF;

  -- The live door beside the closed ones is untouched.
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.proname = 'fn_agent_wallet_send' AND p.pronamespace = 'public'::regnamespace;
  IF v_oid IS NULL OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_agent_wallet_send must remain executable by authenticated - this file must not touch a live door';
  END IF;
END $$;

