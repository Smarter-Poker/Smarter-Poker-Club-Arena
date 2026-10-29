import type { RabbitHuntResult } from './GameServerAPI';

// Private, bounded tab-session receipts. Never persist unseen cards to browser
// storage or a shared hand record. A different login discards every receipt.
let login: string | null = null;
const receipts = new Map<string, RabbitHuntResult>();
const pending = new Map<string, Promise<RabbitHuntResult>>();
function enter(owner: string | null) {
  if (owner !== login) {
    login = owner;
    receipts.clear();
    pending.clear();
  }
}
function key(tableId: string, hand: number) {
  return JSON.stringify([tableId, hand]);
}
function replay(result: RabbitHuntResult): RabbitHuntResult {
  return {
    success: true,
    cards: result.cards?.map((card) => ({ ...card })),
    board_length: result.board_length,
    source: 'already_revealed',
    diamonds_spent: 0,
  };
}
export async function readRabbitReceipt(owner: string | null, tableId: string, hand: number) {
  enter(owner);
  const receipt = owner ? receipts.get(key(tableId, hand)) : undefined;
  if (receipt) return replay(receipt);
  const work = owner ? pending.get(key(tableId, hand)) : undefined;
  const result = work ? await work : null;
  return owner && login === owner && result?.success ? replay(result) : null;
}
export async function withRabbitReceipt(
  owner: string | null,
  tableId: string,
  hand: number | undefined,
  request: () => Promise<RabbitHuntResult>
): Promise<RabbitHuntResult> {
  enter(owner);
  // Unnamed legacy requests cannot be recovered against a moving live hand.
  if (!owner || !Number.isSafeInteger(hand) || (hand ?? 0) < 1) return request();
  const id = key(tableId, hand!);
  const cached = receipts.get(id);
  if (cached) return replay(cached);
  const active = pending.get(id);
  if (active) return active.then((result) => (result.success ? replay(result) : result));
  const work = request();
  pending.set(id, work);
  try {
    const result = await work;
    if (login === owner && result.success && result.cards?.length) {
      receipts.set(id, { ...result, cards: result.cards.map((card) => ({ ...card })) });
      if (receipts.size > 100) receipts.delete(receipts.keys().next().value!);
    }
    return result;
  } finally {
    if (pending.get(id) === work) pending.delete(id);
  }
}
