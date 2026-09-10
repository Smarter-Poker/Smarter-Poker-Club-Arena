/** Equal satellite qualifiers have delivery facts, never a finishing rank. */
export interface SatelliteQualification {
  completionKind: 'equal_qualifiers';
  tournamentId: string;
  userId: string;
  targetId: string;
  amount: number;
  deliveryKind: 'seat' | 'cash' | 'ticket';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Both transports must identify this viewer and this tournament explicitly. */
function parseQualification(
  value: Record<string, unknown> | null,
  tournamentId: string,
  userId: string
): SatelliteQualification | null {
  if (!value || !tournamentId || !userId || userId === 'guest') return null;
  const amount = value.amount;
  if (
    value.completionKind !== 'equal_qualifiers' ||
    value.tournamentId !== tournamentId ||
    value.userId !== userId ||
    typeof value.targetId !== 'string' ||
    !value.targetId.trim() ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(Math.round(amount * 100)) ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001 ||
    typeof value.deliveryKind !== 'string' ||
    !['seat', 'cash', 'ticket'].includes(value.deliveryKind)
  )
    return null;
  return {
    completionKind: 'equal_qualifiers',
    tournamentId,
    userId,
    targetId: value.targetId,
    amount,
    deliveryKind: value.deliveryKind as SatelliteQualification['deliveryKind'],
  };
}

export function parseSatelliteQualificationEvent(
  event: unknown,
  tournamentId: string,
  userId: string
): SatelliteQualification | null {
  const envelope = record(event);
  if (envelope?.type !== 'tournament_qualified') return null;
  const payload = record(envelope.payload);
  return parseQualification(
    payload ? { ...payload, amount: payload.prize } : null,
    tournamentId,
    userId
  );
}

export function parseSatelliteQualificationReceipt(
  receipt: unknown,
  tournamentId: string,
  userId: string
): SatelliteQualification | null {
  const value = record(receipt);
  return parseQualification(
    value
      ? {
          completionKind: value.completion_kind,
          tournamentId: value.tournament_id,
          userId: value.user_id,
          targetId: value.target_id,
          amount: value.amount,
          deliveryKind: value.delivery_kind,
        }
      : null,
    tournamentId,
    userId
  );
}

export function qualificationCashPrize(qualification: SatelliteQualification): number {
  return qualification.deliveryKind === 'cash' ? qualification.amount : 0;
}
