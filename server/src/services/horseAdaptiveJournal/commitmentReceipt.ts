export type CommittedPotAuditReceipt = Readonly<{
  status: 'disabled' | 'unknown' | 'busy' | 'idle' | 'recorded' | 'pass_complete';
  scannedHands: number;
  horseHands: number;
  flaggedHorseHands: number;
  unknownHorseHands: number;
  handGaps: number;
}>;
export const emptyCommittedPotAudit = (
  status: CommittedPotAuditReceipt['status']
): CommittedPotAuditReceipt =>
  Object.freeze({
    status,
    scannedHands: 0,
    horseHands: 0,
    flaggedHorseHands: 0,
    unknownHorseHands: 0,
    handGaps: 0,
  });
const bounded = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Only finite aggregate counters cross worker IPC. A completed source pass
 * does not mean full ingestion coverage, a completed GTO review or a tune. */
export function parseCommittedPotAuditReceipt(value: unknown): CommittedPotAuditReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return emptyCommittedPotAudit('unknown');
  const r = value as Record<string, unknown>;
  if (r.version !== 1 || r.sourceCoverage !== 'not_established' || r.activationAuthorized !== false)
    return emptyCommittedPotAudit('unknown');
  if (r.status === 'idle' || r.status === 'busy') return emptyCommittedPotAudit(r.status);
  if (
    (r.status !== 'recorded' && r.status !== 'pass_complete') ||
    r.gtoVerdict !== 'unverified' ||
    typeof r.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.day) ||
    !bounded(r.scannedHands, 256) ||
    !bounded(r.horseHands, 2560) ||
    !bounded(r.flaggedHorseHands, 2560) ||
    !bounded(r.unknownHorseHands, 2560) ||
    !bounded(r.handGaps, 256) ||
    r.horseHands > r.scannedHands * 10 ||
    r.flaggedHorseHands + r.unknownHorseHands > r.horseHands ||
    r.handGaps > r.scannedHands ||
    (r.status === 'recorded' ? r.scannedHands !== 256 : r.scannedHands >= 256)
  )
    return emptyCommittedPotAudit('unknown');
  return Object.freeze({
    status: r.status,
    scannedHands: r.scannedHands,
    horseHands: r.horseHands,
    flaggedHorseHands: r.flaggedHorseHands,
    unknownHorseHands: r.unknownHorseHands,
    handGaps: r.handGaps,
  });
}

/** Validate the internal IPC projection as a whole before accepting a cycle. */
export function isCommittedPotAuditReceipt(value: unknown): value is CommittedPotAuditReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    typeof r.status !== 'string' ||
    !['disabled', 'unknown', 'busy', 'idle', 'recorded', 'pass_complete'].includes(r.status)
  )
    return false;
  if (
    !bounded(r.scannedHands, 256) ||
    !bounded(r.horseHands, 2560) ||
    !bounded(r.flaggedHorseHands, 2560) ||
    !bounded(r.unknownHorseHands, 2560) ||
    !bounded(r.handGaps, 256)
  )
    return false;
  if (
    r.horseHands > 10 * r.scannedHands ||
    r.flaggedHorseHands + r.unknownHorseHands > r.horseHands ||
    r.handGaps > r.scannedHands
  )
    return false;
  if (r.status === 'recorded') return r.scannedHands === 256;
  if (r.status === 'pass_complete') return r.scannedHands < 256;
  return (
    r.scannedHands === 0 &&
    r.horseHands === 0 &&
    r.flaggedHorseHands === 0 &&
    r.unknownHorseHands === 0 &&
    r.handGaps === 0
  );
}
