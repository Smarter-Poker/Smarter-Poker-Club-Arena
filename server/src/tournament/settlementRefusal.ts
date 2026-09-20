import { UUID_SHAPE } from '../lib/uuidShape.js';

/**
 * These P0404 refusals need missing durable evidence, not another identical
 * money request. Match both the installed authority's exact message and this
 * event; P0404 alone (or a transport error carrying similar text) is not enough.
 *
 * This only ends the write retry loop. The caller must still use its serialized
 * outcome resolver: an earlier ambiguous attempt may already have committed.
 */
export function isDeterministicSettlementRefusal(error: unknown, tournamentId: string): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const value = error as Record<string, unknown>;
  if (value.code !== 'P0404' || typeof value.message !== 'string') return false;
  if (!UUID_SHAPE.test(tournamentId)) return false;
  const eventId = tournamentId.toLowerCase();

  // fn_settle_tournament_rake refuses incomplete original fee attribution.
  if (
    value.message ===
    `tournament ${eventId} rake attribution incomplete: tournament_fee_sources_require_reconciliation`
  ) {
    return true;
  }

  // Ordinary and satellite rankers require the complete durable bust order.
  const sequence =
    /^(?:tournament|satellite) ([0-9a-f-]+) has no complete durable elimination sequence \([0-9]+\/[0-9]+ of [0-9]+\)$/.exec(
      value.message
    );
  return sequence !== null && sequence[0] === value.message && sequence[1] === eventId;
}
