import { getAuthUser, supabase } from '../lib/supabase';

export interface TournamentDealProposal {
  reviewId: string;
  expiresAt: string;
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
  actor_mismatch: 'Your Account Changed. Reopen The Deal Before Continuing.',
  review_not_ready: 'Waiting For Play To Pause Before Reviewing A Split.',
  review_stale: 'This Review Changed. Refresh The Current Review.',
  review_expired: 'This Review Expired. Request A New Review To Continue.',
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
  actorId: string,
  review: TournamentDealReviewState
): TournamentDealProposal {
  const value = successful(raw);
  if (
    review.state !== 'reviewing' ||
    value.review_id !== review.reviewId ||
    value.expires_at !== review.expiresAt ||
    value.proposal_id !== review.proposalId ||
    value.revision !== review.revision ||
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
    reviewId: uuid(value.review_id),
    expiresAt: deadline(value.expires_at),
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
  actorId: string,
  review: TournamentDealReviewState
): Promise<TournamentDealProposal> {
  const { data, error } = await supabase.rpc('fn_get_tournament_deal_proposal', {
    p_tournament_id: tournamentId,
  });
  if (error) throw error;
  return parseTournamentDealProposal(data, tournamentId, actorId, review);
}

export async function castTournamentDealVote(proposal: TournamentDealProposal): Promise<void> {
  const { data: auth, error: authError } = await getAuthUser();
  if (authError || auth.user?.id !== proposal.actorId)
    throw new Error('Your Account Changed. Reopen The Deal Before Voting.');
  const { data, error } = await supabase.rpc('fn_cast_tournament_deal_vote', {
    p_tournament_id: proposal.tournamentId,
    p_proposal_id: proposal.proposalId,
    p_expected_actor_id: proposal.actorId,
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

export type TournamentDealReviewPhase =
  | 'none'
  | 'requested'
  | 'reviewing'
  | 'completed'
  | 'cancelled'
  | 'expired';
export interface TournamentDealReviewState {
  actorId: string;
  tournamentId: string;
  reviewId: string | null;
  state: TournamentDealReviewPhase;
  expiresAt: string | null;
  proposalId: string | null;
  revision: string | null;
  proposal: TournamentDealProposal | null;
}
function deadline(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw invalid();
  return value;
}
export function parseTournamentDealReview(
  raw: unknown,
  tournamentId: string,
  actorId: string
): TournamentDealReviewState {
  const value = successful(raw);
  const phases = ['none', 'requested', 'reviewing', 'completed', 'cancelled', 'expired'];
  if (
    value.actor_id !== actorId ||
    value.tournament_id !== tournamentId ||
    typeof value.state !== 'string' ||
    !phases.includes(value.state)
  )
    throw invalid();
  if (value.state === 'none') {
    if (
      value.review_id !== null ||
      value.expires_at !== null ||
      value.proposal_id !== null ||
      value.revision !== null
    )
      throw invalid();
  } else {
    uuid(value.review_id);
    deadline(value.expires_at);
    if (value.state === 'reviewing') {
      uuid(value.proposal_id);
      if (typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision))
        throw invalid();
    } else if (value.proposal_id !== null || value.revision !== null) throw invalid();
  }
  return {
    actorId,
    tournamentId,
    reviewId: value.review_id as string | null,
    state: value.state as TournamentDealReviewPhase,
    expiresAt: value.expires_at as string | null,
    proposalId: value.proposal_id as string | null,
    revision: value.revision as string | null,
    proposal: null,
  };
}
export async function getTournamentDealReview(
  tournamentId: string,
  actorId: string
): Promise<TournamentDealReviewState> {
  const { data, error } = await supabase.rpc('fn_get_tournament_deal_review', {
    p_tournament_id: tournamentId,
  });
  if (error) throw error;
  const review = parseTournamentDealReview(data, tournamentId, actorId);
  if (review.state === 'reviewing')
    review.proposal = await getTournamentDealProposal(tournamentId, actorId, review);
  return review;
}
async function requireReviewActor(actorId: string): Promise<void> {
  const { data: auth, error } = await getAuthUser();
  if (error || auth.user?.id !== actorId)
    throw new Error('Your Account Changed. Reopen The Deal Before Continuing.');
}
export async function requestTournamentDealReview(
  tournamentId: string,
  actorId: string
): Promise<void> {
  await requireReviewActor(actorId);
  const { data, error } = await supabase.rpc('fn_request_tournament_deal_review', {
    p_tournament_id: tournamentId,
    p_expected_actor_id: actorId,
  });
  if (error) throw error;
  const review = parseTournamentDealReview(data, tournamentId, actorId);
  if (!['requested', 'reviewing'].includes(review.state)) throw invalid();
}
export async function cancelTournamentDealReview(review: TournamentDealReviewState): Promise<void> {
  if (!review.reviewId || !['requested', 'reviewing'].includes(review.state)) throw invalid();
  await requireReviewActor(review.actorId);
  const { data, error } = await supabase.rpc('fn_cancel_tournament_deal_review', {
    p_tournament_id: review.tournamentId,
    p_review_id: review.reviewId,
    p_expected_actor_id: review.actorId,
  });
  if (error) throw error;
  const result = parseTournamentDealReview(data, review.tournamentId, review.actorId);
  if (
    result.reviewId !== review.reviewId ||
    !['cancelled', 'expired', 'completed'].includes(result.state)
  )
    throw invalid();
}
