import { getHeapStatistics } from 'node:v8';

/** Exact encoded retention ceiling: the previous ONE-client envelope, shared
 * by every main-thread client instead of multiplied by worker count. */
export const HISTORY_WINDOW_MAX_BYTES = 256 * 1024;
export const HISTORY_PACKET_MAX_BYTES = HISTORY_WINDOW_MAX_BYTES + 128;
export const HISTORY_ACTIVE_LOADS = 16;
export const HISTORY_AGGREGATE_MAX_BYTES = 2048 * HISTORY_WINDOW_MAX_BYTES;
/** The measured 193,916-byte replica expanded ~1.68x decoded. Round upward;
 * this is an admission allowance, NOT exact V8 retained-heap accounting. */
const REPRESENTATION_ALLOWANCE = 2;
const TRANSIENT_RESERVE =
  (HISTORY_ACTIVE_LOADS + 2) * HISTORY_PACKET_MAX_BYTES * REPRESENTATION_ALLOWANCE;
type Heap = Pick<
  ReturnType<typeof getHeapStatistics>,
  'heap_size_limit' | 'used_heap_size' | 'total_available_size'
>;

export class HorseHistoryRetentionBudget {
  private readonly claims = new Map<object, { bytes: number; evict: () => void }>();
  private retained = 0;
  constructor(
    private readonly maxBytes = HISTORY_AGGREGATE_MAX_BYTES,
    private readonly heap: () => Heap = getHeapStatistics
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HISTORY_AGGREGATE_MAX_BYTES)
      throw Error('Invalid aggregate history retention bound');
  }
  release(owner: object): void {
    const claim = this.claims.get(owner);
    if (!claim) return;
    this.retained -= claim.bytes;
    this.claims.delete(owner);
  }
  reserve(owner: object, bytes: number, evict: () => void): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return false;
    const prior = this.claims.get(owner)?.bytes ?? 0;
    if (bytes <= prior && this.claims.has(owner)) {
      this.retained += bytes - prior;
      this.claims.get(owner)!.bytes = bytes;
      return true;
    }
    // Existing synchronous admission only; no timer, traversal or forced GC.
    let available: number;
    try {
      const h = this.heap();
      available = Math.min(h.total_available_size, h.heap_size_limit - h.used_heap_size);
      if (!Number.isFinite(available) || available < 0) return false;
    } catch {
      return false;
    }
    if ((bytes - prior) * REPRESENTATION_ALLOWANCE + TRANSIENT_RESERVE > available) return false;
    while (this.retained - prior + bytes > this.maxBytes) {
      let victim: object | undefined;
      for (const key of this.claims.keys())
        if (key !== owner) {
          victim = key;
          break;
        }
      if (!victim) return false;
      const callback = this.claims.get(victim)!.evict;
      this.release(victim);
      callback();
    }
    this.retained += bytes - prior;
    this.claims.set(owner, { bytes, evict });
    return true;
  }
  status(): { encodedBytes: number; maxEncodedBytes: number; reservations: number } {
    return {
      encodedBytes: this.retained,
      maxEncodedBytes: this.maxBytes,
      reservations: this.claims.size,
    };
  }
}
/** Numeric ownership only is shared. Original payloads and ACKs remain client-specific. */
export const mainHorseHistoryRetentionBudget = new HorseHistoryRetentionBudget();
