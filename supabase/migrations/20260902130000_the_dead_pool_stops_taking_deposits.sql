-- ═══════════════════════════════════════════════════════════════════════════
--  THE DEAD POOL STOPS TAKING DEPOSITS
--  To-do #2563 item 13, the half Dan approved on 2026-09-01:
--  "decide later, disarm the leak paths now."
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `public.wallets` has been frozen since 2026-08-21 with 732,591,994.33 chips
-- stranded in it; nothing on the platform reads it (CLAUDE.md 11.5). Yet two
-- browser-callable RPCs still moved balances INSIDE it when invoked:
--
--   atomic_chip_transfer   - called by src/services/ChipFlowService.ts:96
--   wallet_user_transfer   - called by src/services/WalletService.ts:446
--
-- Both are user-to-user transfer features. A player who used one today would
-- either hit INSUFFICIENT_BALANCE against a dead row, or "successfully" move
-- dead-pool balances that no screen anywhere displays - money that vanishes
-- from the player's point of view. Live measurement before this ran: the
-- stranded total is UNCHANGED since the freeze date, so these paths have not
-- fired with real amounts recently. They are loaded weapons, not active
-- wounds - and this unloads them.
--
-- DISARM, NOT REWRITE. The features behind these calls belong to whoever
-- owns the transfer UX, and rewriting a money function from a guess is the
-- 10.5 incident shape. The bodies become a single loud refusal that names
-- the sanctioned replacements; the signatures are preserved so the client
-- calls fail with a clear message instead of a 404. The client's own error
-- surface shows the message text, which is why it is Title Case with no em
-- dashes (CLAUDE.md 5.7).
--
-- The repoint of the two client features to the live economy
-- (club_members.chip_balance via fn_club_bank_send / fn_agent_wallet_send /
-- fn_wallet_type_transfer) is the follow-up, tracked on issue #2563.

BEGIN;

CREATE OR REPLACE FUNCTION public.atomic_chip_transfer(
  p_from_user_id uuid, p_to_user_id uuid, p_amount numeric, p_category text,
  p_description text, p_related_entity_id uuid DEFAULT NULL::uuid,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
-- SECURITY INVOKER (the default), deliberately: the original consulted
-- auth.role() under DEFINER; a body that is one RAISE EXCEPTION touches
-- nothing and needs nobody's rights - and the pre-push definer guard
-- correctly refused the DEFINER version for never asking who calls.
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'WALLET_POOL_RETIRED: This Transfer Path Writes A Retired Wallet Pool And Has Been Disabled. Chips Sent Here Would Not Appear Anywhere.'
    USING ERRCODE = '55000',
          HINT = 'Use the club cashier transfer paths (fn_club_bank_send, fn_agent_wallet_send, fn_wallet_type_transfer). Retirement decision: docs/runbooks/public-wallets-retirement.md.';
END;
$function$;

COMMENT ON FUNCTION public.atomic_chip_transfer(uuid, uuid, numeric, text, text, uuid, uuid) IS
  'DISARMED 2026-09-01 (Dan, #2563 item 13). Previously transferred balances inside the retired public.wallets pool - money invisible to every screen. Refuses loudly; the client feature repoints to the live economy as the follow-up.';

CREATE OR REPLACE FUNCTION public.wallet_user_transfer(
  p_from_user_id uuid, p_to_user_id uuid, p_amount numeric,
  p_from_wallet text DEFAULT 'PLAYER'::text, p_to_wallet text DEFAULT 'PLAYER'::text,
  p_reference_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RAISE EXCEPTION
    'WALLET_POOL_RETIRED: This Transfer Path Writes A Retired Wallet Pool And Has Been Disabled. Chips Sent Here Would Not Appear Anywhere.'
    USING ERRCODE = '55000',
          HINT = 'Use the club cashier transfer paths (fn_club_bank_send, fn_agent_wallet_send, fn_wallet_type_transfer). Retirement decision: docs/runbooks/public-wallets-retirement.md.';
END;
$function$;

COMMENT ON FUNCTION public.wallet_user_transfer(uuid, uuid, numeric, text, text, uuid) IS
  'DISARMED 2026-09-01 (Dan, #2563 item 13). Previously transferred balances inside the retired public.wallets pool. Refuses loudly; the client feature repoints to the live economy as the follow-up.';

COMMIT;
