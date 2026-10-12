import { UUID_SHAPE } from '../lib/uuidShape.js';

/**
 * A POSTGRES ERROR IS AN ANSWER, NOT A LOST RESPONSE (2026-10-04).
 *
 * PostgREST runs an RPC as one transaction. When the statement (or its
 * COMMIT) raises, PostgREST rolls the transaction back and returns the
 * error's SQLSTATE in the body. So a five-character SQLSTATE in the body is
 * the database itself saying the call did not commit. A transport failure is
 * different: postgrest-js reports it with `code: ''`, and a gateway error
 * carries no SQLSTATE at all, and only those leave the outcome open.
 *
 * Classes that can describe a connection or a server that died around a
 * COMMIT are excluded and stay uncertain: 08 (connection exception), 57
 * (operator intervention, including a cancel), 58 (system error), 53
 * (insufficient resources) and XX (internal error). PGRST codes are eight
 * characters and never match.
 *
 * Production 2026-10-03 20:13:03Z, satellite ab4a05ce: the qualifier
 * settlement waited eight seconds for the exclusive finish lane and was
 * cancelled with 55P03 (lock_timeout). It had not committed, and the body
 * said so. The engine treated it as a lost response, asked the resolver,
 * whose own lane wait hit the same 55P03, and fenced the event's dealers
 * with a critical alert. The next pass settled it at 20:13:48Z.
 */
const UNCERTAIN_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58', 'XX']);

export function isRolledBackStatementError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const code = (error as Record<string, unknown>).code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return false;
  return !UNCERTAIN_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

/**
 * Lane contention: the serialized read could not take its lock or was
 * chosen as a victim. It read nothing, and asking again is safe because the
 * resolver writes nothing.
 */
export function isLaneContention(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const code = (error as Record<string, unknown>).code;
  return code === '55P03' || code === '40001' || code === '40P01' || code === '57014';
}

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
