/**
 * Every transaction_type that represents an agent DISTRIBUTING chips to their
 * downline, across both eras of the cashier.
 *
 * The first three are the LEGACY types. Nothing writes them any more — the
 * canonical send path (fn_agent_wallet_send / fn_club_bank_send, 2026-08-31)
 * writes 'agent_wallet_send' and 'club_bank_send' — but history holds them,
 * so read surfaces must keep matching them.
 *
 * Found 2026-09-01 on Deep Stack Society: the agent analytics dashboard,
 * score card and distribution history all filtered on the legacy list only,
 * so an agent who had just distributed 600,000 through the canonical
 * cashier saw ZERO distributions.
 *
 * DO NOT use this list for clawback eligibility. The legacy clawback path
 * (AgentService.clawbackableTypes) deliberately matches only the legacy
 * types; canonical sends claw back through fn_agent_wallet_claim_back with
 * its own server-side window and rules. Routing a canonical send through
 * the legacy clawback would be a money bug, not a display fix.
 */
export const AGENT_DISTRIBUTION_READ_TYPES = [
  // legacy (history only)
  'agent_to_player',
  'promo_agent_to_player',
  'send',
  // canonical (2026-08-31 cashier)
  'agent_wallet_send',
  'club_bank_send',
] as const;
