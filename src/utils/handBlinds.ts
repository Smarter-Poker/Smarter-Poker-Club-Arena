/** A display denomination belongs to one table and one dealt hand. */
export interface HandBlinds {
  tableId: string;
  handNumber: number;
  smallBlind: number;
  bigBlind: number;
}

export function parseHandBlinds(
  raw: unknown,
  tableId: unknown,
  handNumber: unknown
): HandBlinds | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (
    typeof tableId !== 'string' ||
    !tableId ||
    b.table_id !== tableId ||
    !Number.isSafeInteger(handNumber) ||
    Number(handNumber) <= 0 ||
    b.hand_number !== handNumber ||
    typeof b.small_blind !== 'number' ||
    !Number.isFinite(b.small_blind) ||
    b.small_blind < 0 ||
    typeof b.big_blind !== 'number' ||
    !Number.isFinite(b.big_blind) ||
    b.big_blind <= 0 ||
    b.small_blind > b.big_blind
  )
    return null;
  return {
    tableId,
    handNumber: Number(handNumber),
    smallBlind: b.small_blind,
    bigBlind: b.big_blind,
  };
}

/** Legacy tournament metadata cannot certify the denomination of a dealt hand. */
export function displayBigBlind(
  hand: HandBlinds | null | undefined,
  tableId: string,
  handNumber: number | undefined,
  tournament: boolean,
  metadataBigBlind: number
): number {
  if (hand?.tableId === tableId && hand.handNumber === handNumber) return hand.bigBlind;
  return tournament ? 0 : metadataBigBlind;
}
