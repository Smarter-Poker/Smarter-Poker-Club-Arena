-- ═══════════════════════════════════════════════════════════════════════════
--  AGENT TO AGENT ALWAYS CREDITS THE AGENT WALLET
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-25, verbatim:
--   "AGENT TO AGENT SEND OR CLAIM BACK ALWAYS CREDIT TO AGENT WALLETS."
--
-- fn_agent_wallet_send guarded exactly one direction. It refused
-- p_destination = 'agent_wallet' when the recipient was not staff or an agent
-- (a player cannot hold a float), but it never refused the OPPOSITE mistake.
-- A send from an agent wallet to another AGENT carrying
-- p_destination = 'player_wallet' was accepted, and the chips landed in that
-- agent's club_members.chip_balance: the balance they buy in with, not the
-- float they distribute from.
--
-- That is reachable from the UI today, not merely in theory. The agent-wallet
-- cashier offers both destinations (cashierDestinations returns
-- ['player_wallet','agent_wallet']), so an agent funding a sub agent could
-- pick the wrong one and there was no rule underneath to stop them.
--
-- The consequences compound rather than staying put:
--   * the sub agent's float never grows, so their own Send Out keeps failing
--     with "Your Agent Wallet Only Holds 0 Chips" while their player balance
--     silently swells;
--   * the ten-minute claim back reads metadata->>'destination' to decide which
--     account to debit, so it would pull the correction out of the player
--     balance - a different pot from the one that was funded;
--   * a downline's float and their personal stack stop being separable in the
--     ledger, which is the entire point of having two columns.
--
-- WHY THE DATABASE AND NOT THE DROPDOWN. A client-side rule is a suggestion.
-- Anything holding a session can call this RPC directly with whatever
-- destination it likes, and the UI change that accompanies this migration only
-- narrows what is easy, not what is possible. The destination is now DERIVED
-- from the recipient's role rather than trusted from the caller, which makes
-- the rule true for every surface that exists now or later.
--
-- Patched by string replacement against pg_get_functiondef, the technique
-- 20260823310000 established, so the other ~200 lines of a money function stay
-- byte-identical rather than being restated from a dashboard dump.

DO $migrate$
DECLARE
  v_def text;
  v_new text;
  v_anchor text;
  v_replacement text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_agent_wallet_send';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_agent_wallet_send not found - refusing to guess';
  END IF;

  v_anchor :=
    '  if v_dest = ''agent_wallet''' || E'\n' ||
    '     and v_to_role not in (''owner'', ''co_owner'', ''admin'', ''super_agent'', ''agent'', ''sub_agent'') then' || E'\n' ||
    '    return jsonb_build_object(''success'', false,' || E'\n' ||
    '      ''error'', ''Only Staff Or Agents Hold An Agent Wallet'');' || E'\n' ||
    '  end if;';

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'destination guard not found in fn_agent_wallet_send - refusing to patch blind';
  END IF;

  v_replacement := v_anchor || E'\n\n' ||
    '  -- AGENT TO AGENT ALWAYS CREDITS THE AGENT WALLET (Dan 2026-08-25).' || E'\n' ||
    '  -- Derived from the recipient, never trusted from the caller: a recipient' || E'\n' ||
    '  -- who holds a float is funded IN that float, whatever the client asked' || E'\n' ||
    '  -- for. Paying an agent through their personal balance leaves the account' || E'\n' ||
    '  -- they distribute from empty and makes the ten minute claim back pull' || E'\n' ||
    '  -- from the wrong pot.' || E'\n' ||
    '  if v_to_role in (''owner'', ''co_owner'', ''admin'', ''super_agent'', ''agent'', ''sub_agent'') then' || E'\n' ||
    '    v_dest := ''agent_wallet'';' || E'\n' ||
    '  end if;';

  v_new := replace(v_def, v_anchor, v_replacement);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op - refusing to ship an unchanged function';
  END IF;

  EXECUTE v_new;
END
$migrate$;

-- Proof in the same transaction as the patch. A migration that silently
-- no-ops is worse than one that fails loudly, because the rule would then be
-- documented everywhere and enforced nowhere.
DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_wallet_send';

  IF position('v_dest := ''agent_wallet'';' IN v_def) = 0 THEN
    RAISE EXCEPTION 'coercion did not take: an agent can still be paid into their player balance';
  END IF;
  IF position('Only Staff Or Agents Hold An Agent Wallet' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the non-agent guard was lost';
  END IF;
END
$verify$;
