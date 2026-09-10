import { getAuthUser, supabase } from '../lib/supabase';

export interface TournamentDealProposal {
  actorId: string;
  tournamentId: string;
  proposalId: string;
  revision: string;
  shares: Array<{ userId: string; place: number; chips: string; amountCents: string }>;
  poolCents: string;
  dealCents: string;
  voterIds: string[];
}

const messages: Record<string, string> = {
  proposal_authority_not_active: 'Deal Review Is Not Available Yet. Please Retry.',
  pool_not_finalized: 'The Prize Pool Must Be Finalized Before A Deal.',
  deal_not_ready: 'A Deal Is Not Ready Yet.',
  voter_not_alive: 'Only Remaining Players Can Vote On This Deal.',
  proposal_stale: 'This Split Changed. Review The Latest Split Before Voting Again.',
  proposal_not_found: 'This Split Is No Longer Available. Review The Latest Split.',
};
export class TournamentDealRefusal extends Error {
  constructor(readonly reason: string) {
    super(messages[reason] ?? 'Deal Details Are Unavailable. Please Retry.');
  }
}
const invalid = () => new Error('The Deal Response Could Not Be Verified. Please Retry.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw invalid();
  return value;
}
function cents(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw invalid();
  return value;
}
function successful(raw: unknown): Record<string, unknown> {
  const value = object(raw);
  if (value.ok === false && typeof value.reason === 'string')
    throw new TournamentDealRefusal(value.reason);
  if (value.ok !== true) throw invalid();
  return value;
}

export function parseTournamentDealProposal(
  raw: unknown,
  tournamentId: string,
  actorId: string
): TournamentDealProposal {
  const value = successful(raw);
  if (
    value.tournament_id !== tournamentId ||
    value.actor_id !== actorId ||
    value.state !== 'ready' ||
    typeof value.revision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.revision) ||
    !Array.isArray(value.shares) ||
    value.shares.length === 0 ||
    !Array.isArray(value.voter_ids)
  )
    throw invalid();
  const users = new Set<string>();
  const places = new Set<number>();
  const shares = value.shares.map((rawShare) => {
    const share = object(rawShare);
    const userId = uuid(share.user_id);
    if (
      !Number.isSafeInteger(share.place) ||
      Number(share.place) <= 0 ||
      users.has(userId) ||
      places.has(Number(share.place)) ||
      typeof share.chips !== 'string' ||
      !/^[0-9]+(?:\.[0-9]+)?$/.test(share.chips) ||
      !/[1-9]/.test(share.chips)
    )
      throw invalid();
    users.add(userId);
    places.add(Number(share.place));
    const amountCents = cents(share.amount_cents);
    if (BigInt(amountCents) <= 0n) throw invalid();
    return { userId, place: Number(share.place), chips: share.chips, amountCents };
  });
  const voterIds = value.voter_ids.map(uuid);
  if (
    !users.has(actorId) ||
    new Set(voterIds).size !== voterIds.length ||
    voterIds.some((id) => !users.has(id))
  )
    throw invalid();
  const poolCents = cents(value.pool_cents);
  const dealCents = cents(value.deal_cents);
  if (
    shares.reduce((sum, share) => sum + BigInt(share.amountCents), 0n) !== BigInt(dealCents) ||
    BigInt(dealCents) > BigInt(poolCents)
  )
    throw invalid();
  return {
    actorId,
    tournamentId,
    proposalId: uuid(value.proposal_id),
    revision: value.revision,
    shares,
    poolCents,
    dealCents,
    voterIds,
  };
}

/** Format the server's exact cents, without calculating or rounding any award. */
export function formatDealCents(value: string): string {
  const amount = BigInt(cents(value));
  const whole = (amount / 100n).toLocaleString('en-US');
  const fraction = amount % 100n;
  return fraction === 0n ? whole : `${whole}.${fraction < 10n ? '0' : ''}${fraction}`;
}

export async function getTournamentDealProposal(
  tournamentId: string,
  actorId: string
): Promise<TournamentDealProposal> {
  const { data, error } = await supabase.rpc('fn_get_tournament_deal_proposal', {
    p_tournament_id: tournamentId,
  });
  if (error) throw error;
  return parseTournamentDealProposal(data, tournamentId, actorId);
}

export async function castTournamentDealVote(proposal: TournamentDealProposal): Promise<void> {
  const { data: auth, error: authError } = await getAuthUser();
  if (authError || auth.user?.id !== proposal.actorId)
    throw new Error('Your Account Changed. Reopen The Deal Before Voting.');
  const { data, error } = await supabase.rpc('fn_cast_tournament_deal_vote', {
    p_tournament_id: proposal.tournamentId,
    p_proposal_id: proposal.proposalId,
  });
  if (error) throw error;
  const result = successful(data);
  if (
    result.actor_id !== proposal.actorId ||
    result.proposal_id !== proposal.proposalId ||
    result.revision !== proposal.revision ||
    result.voted !== true ||
    typeof result.already !== 'boolean'
  )
    throw invalid();
}
