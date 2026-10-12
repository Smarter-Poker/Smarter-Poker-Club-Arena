import { masterBus } from '../core/MasterBus';
import { supabase } from './supabase';
import { reportError } from '../utils/errorReporter';
export interface DiamondJackpotStake {
  big_blind: number;
  drop: number;
  min_pot: number;
  payout_percent: number;
  loser_percent: number;
  winner_percent: number;
  table_percent: number;
  mini_amount: number;
  mini_payable: boolean;
}
export interface DiamondJackpotHit {
  id: string;
  table_id: string;
  hand_number: number;
  hand_id: string;
  kind: 'main' | 'mini';
  created_at: string;
  loser_name: string;
  winner_name: string;
  loser_avatar_url?: string | null;
  loser_player_number?: string | null;
  verdict: { loser_hand: string; winner_hand: string };
  receipt: {
    total: number;
    loser: { userId: string; share: number };
    winner: { userId: string; share: number };
    tableShare: number;
    perPlayerShare: number;
  };
}
export interface DiamondJackpotSnapshot {
  version: 1;
  pool_id: string | null;
  enabled: boolean;
  main_balance: number;
  mini_enabled: boolean;
  backup_balance: number;
  reserve_floor: number;
  stakes: DiamondJackpotStake[];
  hits: DiamondJackpotHit[];
}
function whole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('diamond_jackpot_snapshot_invalid_money');
  return value;
}
export function parseDiamondJackpotSnapshot(raw: unknown): DiamondJackpotSnapshot {
  const x = raw as DiamondJackpotSnapshot;
  if (
    !x ||
    x.version !== 1 ||
    typeof x.enabled !== 'boolean' ||
    typeof x.mini_enabled !== 'boolean' ||
    !Array.isArray(x.stakes) ||
    !Array.isArray(x.hits)
  )
    throw new Error('diamond_jackpot_snapshot_invalid');
  [x.main_balance, x.backup_balance, x.reserve_floor].forEach(whole);
  for (const s of x.stakes) {
    [
      s.big_blind,
      s.drop,
      s.min_pot,
      s.payout_percent,
      s.loser_percent,
      s.winner_percent,
      s.table_percent,
      s.mini_amount,
    ].forEach(whole);
    if (typeof s.mini_payable !== 'boolean' || s.payout_percent > 100)
      throw new Error('diamond_jackpot_snapshot_invalid_stake');
  }
  for (const h of x.hits) {
    if (!h.id || !['main', 'mini'].includes(h.kind) || !h.receipt)
      throw new Error('diamond_jackpot_snapshot_invalid_hit');
    [
      h.receipt.total,
      h.receipt.loser.share,
      h.receipt.winner.share,
      h.receipt.tableShare,
      h.receipt.perPlayerShare,
    ].forEach(whole);
    if (h.receipt.loser.share + h.receipt.winner.share + h.receipt.tableShare !== h.receipt.total)
      throw new Error('diamond_jackpot_snapshot_hit_disagrees');
  }
  return x;
}
type Listener = { snapshot: (snapshot: DiamondJackpotSnapshot) => void; error?: () => void };
interface Feed {
  listeners: Set<Listener>;
  last: DiamondJackpotSnapshot | null;
  stop: () => void;
}
const feeds = new Map<string, Feed>();
/** One read-only observer per club, shared across every open table and lobby. */
export function subscribeDiamondJackpot(
  clubId: string,
  onSnapshot: (snapshot: DiamondJackpotSnapshot) => void,
  onError?: () => void
): () => void {
  const listener: Listener = { snapshot: onSnapshot, error: onError };
  let feed = feeds.get(clubId);
  if (!feed) {
    let alive = true,
      reading = false;
    const owned: Feed = { listeners: new Set(), last: null, stop: () => {} };
    feeds.set(clubId, owned);
    feed = owned;
    const read = async () => {
      if (!alive || reading) return;
      reading = true;
      try {
        const { data, error } = await supabase.rpc('fn_poker_diamond_jackpot_for_club', {
          p_club_id: clubId,
        });
        if (error) throw error;
        const snapshot = parseDiamondJackpotSnapshot(data);
        if (alive) {
          owned.last = snapshot;
          for (const item of owned.listeners) item.snapshot(snapshot);
        }
      } catch (error) {
        if (alive) {
          owned.last = null;
          reportError(error, 'DiamondJackpot.read');
          for (const item of owned.listeners) item.error?.();
        }
      } finally {
        reading = false;
      }
    };
    const channel = supabase
      .channel('diamond-jackpot:' + clubId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'poker_diamond_jackpot_hits',
          filter: 'arena_id=eq.' + clubId,
        },
        (payload) => {
          void read();
          const row = payload.new as { id?: string; paid?: boolean; kind?: string };
          if (row.paid !== true || row.kind !== 'main' || !row.id) return;
          void (async () => {
            try {
              const { data, error } = await supabase.rpc('fn_poker_diamond_jackpot_for_club', {
                p_club_id: clubId,
              });
              if (error) throw error;
              const hit = parseDiamondJackpotSnapshot(data).hits.find((h) => h.id === row.id);
              if (!alive || !hit) return;
              masterBus.emit('BBJ_HIT_GLOBAL', {
                tableId: hit.table_id,
                tableName: 'Diamond Arena',
                gameVariant: 'Poker',
                bigBlind: 0,
                winnerName: hit.loser_name,
                amount: hit.receipt.loser.share,
                handNumber: hit.hand_number,
                emittedAt: Date.parse(hit.created_at),
                asset: 'diamonds',
              });
            } catch (error) {
              if (alive) reportError(error, 'DiamondJackpot.announcement');
            }
          })();
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void read();
      });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void read();
    }, 60_000);
    const visible = () => {
      if (document.visibilityState !== 'hidden') void read();
    };
    document.addEventListener('visibilitychange', visible);
    owned.stop = () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      void supabase.removeChannel(channel);
    };
    void read();
  }
  feed.listeners.add(listener);
  if (feed.last) onSnapshot(feed.last);
  const owned = feed;
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size === 0) {
      owned.stop();
      if (feeds.get(clubId) === owned) feeds.delete(clubId);
    }
  };
}
