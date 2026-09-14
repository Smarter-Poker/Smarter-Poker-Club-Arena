/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE SOURCE FOR THE MINI JACKPOT
 *  BBJ programme phase 2 of 5 (Dan 2026-09-09: "MINI BBJ NEEDS TO BE SEEN AND
 *  DISCOVERABLE LIKE THE BBJ CURRENTLY IS")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The main jackpot figure is a slowly drifting total (lib/bbjPoolFeed). The
 * mini is a different shape: a FLAT amount per stakes tier, paid out of the
 * backup reserve, refused when the reserve would drop below its floor. What a
 * surface needs to say is therefore not "how much is in it" but "what does it
 * pay at these stakes, and can it pay right now". `fn_bbj_mini_for_club`
 * answers both, with the same floor test the payout RPC applies, so the felt
 * never promises a mini the engine is about to refuse.
 *
 * It moves rarely: the tier amounts are configuration, and the reserve moves
 * only when a mini hits or an operator funds it. So this polls once a minute
 * per club - not per surface - and only while the document is visible, and it
 * re-reads immediately when a hit lands (lib/bbjHitFeed calls `refreshBbjMini`)
 * because that is the one moment the answer changes under a player's eyes.
 *
 * REFUSES TO GUESS, like the pool feed. A failed read leaves the last known
 * snapshot in place and reports; a surface that has never been told anything
 * shows nothing about the mini rather than inventing an amount.
 */

import { supabase } from './supabase';
import { reportError } from '../utils/errorReporter';

export interface BbjMiniTier {
  tierId: string;
  label: string;
  blindRange: string;
  minBB: number;
  maxBB: number;
  amount: number;
  enabled: boolean;
  /** enabled AND the reserve can pay this amount without breaching its floor. */
  payable: boolean;
}

export interface BbjMiniSnapshot {
  poolId: string | null;
  /**
   * The mini pays here. False means switched off - either by this club's own
   * switch or because no stakes tier is enabled at all. The felt asks nothing
   * more than this; only the settings page needs to tell the two apart.
   */
  enabled: boolean;
  /** THIS POOL's switch (Dan 2026-09-11), separate from the global tier flags. */
  clubSwitch: boolean;
  /** The club owns that switch: it has no union, so the pool is its own. */
  canToggle: boolean;
  /** The pool is a union pool, shared with every other club in that union. */
  isUnionPool: boolean;
  backupBalance: number;
  reserveFloor: number;
  parked: number;
  /** Reserve headroom above the floor after parked shares - what the mini can still pay. */
  available: number;
  tiers: BbjMiniTier[];
  hits30d: number;
  paid30d: number;
  lastHitAt: string | null;
  /* THE RUNWAY (phase 3). Both rates are measured over ONE window -
     `windowDays`, which is seven days or the mini's age, whichever is shorter -
     so they are comparable. A seven-day divisor on a four-day-old mini reported
     a spend rate about half the real one, which is how a pool can read solvent
     while draining. */
  /**
   * THE RATES ARE THE CLUB'S BUSINESS, so the database returns them only to
   * that club's staff: `in_per_day` is its daily jackpot rake income. NULL
   * here means "not yours to see", which is NOT the same as a rate of zero -
   * so these are nullable all the way to the surface rather than flattened
   * through `num()`. `isOperator` says which case you are in.
   */
  inPerDay: number | null;
  outPerDay: number | null;
  netPerDay: number | null;
  /** Days until the reserve reaches its floor. NULL when not draining, or hidden. */
  daysToFloor: number | null;
  /** The lowest floor the database will accept: one payout at the largest tier. */
  floorMinimum: number | null;
  windowDays: number | null;
  /** The caller is staff of this club, so the rates above are populated. */
  isOperator: boolean;
}

export type BbjMiniListener = (snapshot: BbjMiniSnapshot) => void;
export type BbjMiniReadOutcome = 'ready' | 'empty' | 'error';

/** Sixty seconds: configuration plus a reserve that moves on hits, not on hands. */
export const BBJ_MINI_POLL_MS = 60_000;

interface ClubFeed {
  listeners: Set<BbjMiniListener>;
  timer: ReturnType<typeof setInterval> | null;
  last: BbjMiniSnapshot | null;
  reading: boolean;
  firstRead: BbjMiniReadOutcome | null;
  firstReadListeners: Set<(outcome: BbjMiniReadOutcome) => void>;
}

const feeds = new Map<string, ClubFeed>();

function documentIsVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Like `num`, but NULL and undefined survive as null rather than becoming 0. */
function maybeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTiers(raw: unknown): BbjMiniTier[] {
  if (!Array.isArray(raw)) return [];
  const out: BbjMiniTier[] = [];
  for (const t of raw as Array<Record<string, unknown>>) {
    if (!t || typeof t !== 'object') continue;
    const tierId = String(t.tierId ?? '');
    if (!tierId) continue;
    out.push({
      tierId,
      label: String(t.label ?? tierId),
      blindRange: String(t.blindRange ?? ''),
      minBB: num(t.minBB),
      maxBB: num(t.maxBB),
      amount: num(t.amount),
      enabled: t.enabled === true,
      payable: t.payable === true,
    });
  }
  return out;
}

function sameSnapshot(a: BbjMiniSnapshot | null, b: BbjMiniSnapshot): boolean {
  if (!a) return false;
  if (
    a.poolId !== b.poolId ||
    a.enabled !== b.enabled ||
    a.clubSwitch !== b.clubSwitch ||
    a.canToggle !== b.canToggle ||
    a.isUnionPool !== b.isUnionPool ||
    a.backupBalance !== b.backupBalance ||
    a.reserveFloor !== b.reserveFloor ||
    a.parked !== b.parked ||
    a.available !== b.available ||
    a.hits30d !== b.hits30d ||
    a.paid30d !== b.paid30d ||
    a.lastHitAt !== b.lastHitAt ||
    a.inPerDay !== b.inPerDay ||
    a.outPerDay !== b.outPerDay ||
    a.netPerDay !== b.netPerDay ||
    a.daysToFloor !== b.daysToFloor ||
    a.floorMinimum !== b.floorMinimum ||
    a.windowDays !== b.windowDays ||
    a.isOperator !== b.isOperator ||
    a.tiers.length !== b.tiers.length
  ) {
    return false;
  }
  for (let i = 0; i < a.tiers.length; i++) {
    const x = a.tiers[i];
    const y = b.tiers[i];
    if (
      x.tierId !== y.tierId ||
      x.amount !== y.amount ||
      x.enabled !== y.enabled ||
      x.payable !== y.payable
    ) {
      return false;
    }
  }
  return true;
}

async function readOnce(clubId: string, feed: ClubFeed): Promise<void> {
  if (feed.reading) return;
  feed.reading = true;
  let outcome: BbjMiniReadOutcome = 'error';
  try {
    const { data, error } = await supabase.rpc('fn_bbj_mini_for_club', { p_club_id: clubId });
    if (error) {
      reportError(error, 'bbjMiniFeed.read_failed', { clubId });
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) {
      outcome = 'empty';
      return;
    }
    const next: BbjMiniSnapshot = {
      poolId: (row.pool_id as string) ?? null,
      enabled: row.enabled === true,
      /* Absent on a cached older row: default to the safe reading, which is
         "on, and not yours to change" - never invent a control. */
      clubSwitch: row.club_switch !== false,
      canToggle: row.can_toggle === true,
      isUnionPool: row.is_union_pool === true,
      backupBalance: num(row.backup_balance),
      reserveFloor: num(row.reserve_floor),
      parked: num(row.parked),
      available: num(row.available),
      tiers: parseTiers(row.tiers),
      hits30d: num(row.hits_30d),
      paid30d: num(row.paid_30d),
      lastHitAt: row.last_hit_at ? String(row.last_hit_at) : null,
      /* NULL stays NULL on every one of these. For days_to_floor a zero would
         read as "the floor is reached today" rather than "not draining"; for
         the rates it would read as "this club earns nothing" rather than "you
         may not see it". */
      inPerDay: maybeNum(row.in_per_day),
      outPerDay: maybeNum(row.out_per_day),
      netPerDay: maybeNum(row.net_per_day),
      daysToFloor: maybeNum(row.days_to_floor),
      floorMinimum: maybeNum(row.floor_minimum),
      windowDays: maybeNum(row.window_days),
      isOperator: row.is_operator === true,
    };
    outcome = 'ready';
    if (sameSnapshot(feed.last, next)) return;
    feed.last = next;
    for (const listener of feed.listeners) {
      try {
        listener(next);
      } catch (e) {
        reportError(e, 'bbjMiniFeed.listener_threw', { clubId });
      }
    }
  } catch (e) {
    reportError(e, 'bbjMiniFeed.read_threw', { clubId });
  } finally {
    feed.reading = false;
    feed.firstRead = outcome;
    for (const listener of feed.firstReadListeners) {
      try {
        listener(outcome);
      } catch (e) {
        reportError(e, 'bbjMiniFeed.first_read_listener_threw', { clubId });
      }
    }
    feed.firstReadListeners.clear();
  }
}

function tick(clubId: string, feed: ClubFeed): void {
  if (!documentIsVisible()) return;
  void readOnce(clubId, feed);
}

let visibilityHooked = false;
function onVisible(): void {
  if (!documentIsVisible()) return;
  for (const [clubId, feed] of feeds) void readOnce(clubId, feed);
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisible);
  visibilityHooked = true;
}

/**
 * Watch a club's mini jackpot. Returns the unsubscribe. The listener is called
 * immediately with the last known snapshot when one exists.
 */
export function watchBbjMini(
  clubId: string,
  listener: BbjMiniListener,
  onFirstRead?: (outcome: BbjMiniReadOutcome) => void
): () => void {
  if (!clubId) return () => undefined;
  hookVisibility();

  let feed = feeds.get(clubId);
  if (!feed) {
    feed = {
      listeners: new Set(),
      timer: null,
      last: null,
      reading: false,
      firstRead: null,
      firstReadListeners: new Set(),
    };
    feeds.set(clubId, feed);
  }
  const owned = feed;
  owned.listeners.add(listener);
  if (owned.last) listener(owned.last);
  if (onFirstRead) {
    if (owned.last) onFirstRead('ready');
    else if (owned.firstRead) onFirstRead(owned.firstRead);
    else owned.firstReadListeners.add(onFirstRead);
  }

  if (owned.timer === null) {
    void readOnce(clubId, owned);
    owned.timer = setInterval(() => tick(clubId, owned), BBJ_MINI_POLL_MS);
  }

  return () => {
    owned.listeners.delete(listener);
    if (onFirstRead) owned.firstReadListeners.delete(onFirstRead);
    if (owned.listeners.size > 0) return;
    if (owned.timer !== null) clearInterval(owned.timer);
    feeds.delete(clubId);
  };
}

/**
 * Re-read every watched club now. Called when a jackpot hit lands
 * (lib/bbjHitFeed): a mini just left the reserve, so "can it pay" may have
 * changed, and a minute is too long to keep showing a figure the engine would
 * now refuse.
 */
export function refreshBbjMini(): void {
  for (const [clubId, feed] of feeds) void readOnce(clubId, feed);
}

/**
 * The tier that pays at a given big blind, or null when the feed has no such
 * tier. The same cascade the server's `tierIdForBB` applies - the first tier,
 * in ascending order, whose ceiling the big blind does not exceed - so the
 * amount a surface shows is the amount `fn_bbj_mini_payout` would look up.
 */
export function miniTierForBB(
  snapshot: BbjMiniSnapshot | null,
  bigBlind: number
): BbjMiniTier | null {
  if (!snapshot || !Number.isFinite(bigBlind) || bigBlind <= 0) return null;
  const sorted = [...snapshot.tiers].sort((a, b) => a.maxBB - b.maxBB);
  for (const t of sorted) {
    if (bigBlind <= t.maxBB) return t;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

/**
 * THE ONE ANSWER TO "DOES THE MINI ROW DRAW, AND AT WHAT FIGURE".
 *
 * `TablePage` stamps `data-bbj-mini` so the felt reserves the row's height, and
 * `TableModalsLayer` decides whether to render it. Those were two separate
 * expressions: the stamp tested `tier.payable`, the render additionally tested
 * `amount > 0`. A payable tier with a zero amount - which `num()` above will
 * produce from any non-numeric amount a cached row carries - reserved 14px of
 * felt for a row that was never drawn. Both now ask this, so the reservation
 * and the row are the same decision by construction.
 *
 * Returns the amount to print, or null when no row should be drawn.
 */
export function miniPlateAmount(snapshot: BbjMiniSnapshot | null, bigBlind: number): number | null {
  if (!snapshot || !snapshot.enabled) return null;
  const tier = miniTierForBB(snapshot, bigBlind);
  if (!tier || !tier.payable) return null;
  return tier.amount > 0 ? tier.amount : null;
}

/**
 * Turn the mini on or off for a club that owns its own pool (Dan 2026-09-11).
 *
 * The database is the authority on who may do this and on whether this club
 * owns the switch at all: `fn_bbj_set_club_mini_enabled` checks the caller's
 * club role and refuses a club inside a union. This returns the reason it gave
 * rather than throwing, so the settings page can say WHY rather than just
 * failing, and it re-reads the feed on success so every other surface follows
 * within the same tick instead of a minute later.
 */
export async function setBbjMiniEnabled(
  clubId: string,
  enabled: boolean
): Promise<{ ok: true; enabled: boolean } | { ok: false; reason: string }> {
  try {
    const { data, error } = await supabase.rpc('fn_bbj_set_club_mini_enabled', {
      p_club_id: clubId,
      p_enabled: enabled,
    });
    if (error) {
      reportError(error, 'bbjMiniFeed.set_failed', { clubId, enabled });
      return { ok: false, reason: 'request_failed' };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok !== true) {
      return { ok: false, reason: String(row.reason ?? 'refused') };
    }
    refreshBbjMini();
    return { ok: true, enabled: row.mini_enabled !== false };
  } catch (e) {
    reportError(e, 'bbjMiniFeed.set_threw', { clubId, enabled });
    return { ok: false, reason: 'request_failed' };
  }
}

/**
 * Set a club's mini reserve floor (phase 3). Same shape as
 * `setBbjMiniEnabled`: the DATABASE decides who may do this, whether the club
 * owns its pool at all, and how low the floor may go - the floor may not fall
 * below one payout at the largest enabled tier, or the felt would promise an
 * amount the payout RPC must refuse. Returns the reason rather than throwing,
 * and re-reads the feed on success.
 */
export async function setBbjMiniFloor(
  clubId: string,
  floor: number
): Promise<{ ok: true; floor: number } | { ok: false; reason: string; minimum?: number }> {
  try {
    const { data, error } = await supabase.rpc('fn_bbj_set_club_mini_floor', {
      p_club_id: clubId,
      p_floor: floor,
    });
    if (error) {
      reportError(error, 'bbjMiniFeed.set_floor_failed', { clubId, floor });
      return { ok: false, reason: 'request_failed' };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok !== true) {
      return {
        ok: false,
        reason: String(row.reason ?? 'refused'),
        minimum: row.minimum === undefined ? undefined : num(row.minimum),
      };
    }
    refreshBbjMini();
    return { ok: true, floor: num(row.mini_reserve_floor) };
  } catch (e) {
    reportError(e, 'bbjMiniFeed.set_floor_threw', { clubId, floor });
    return { ok: false, reason: 'request_failed' };
  }
}

/**
 * THE UNION'S OWN TWO CONTROLS (2026-09-11).
 *
 * The two above are keyed on a CLUB and both refuse a club inside a union with
 * `union_club_follows_the_union` - correctly, because one member club must not
 * decide what every table under a union pays. The union was then given nothing
 * to follow that sentence to: there was no `fn_bbj_set_union_mini_*` at all,
 * and the LARGER pool on this platform is a union pool. So the mini's switch
 * and its reserve floor were unreachable for the pool they matter most to.
 *
 * Same shape as the club pair on purpose - the database decides who may call
 * them (`fn_is_union_operator`: the union's owner, or a row in `union_admins`)
 * and how low the floor may go (one payout at the largest enabled tier) - and
 * the reason comes back rather than being thrown, so the surface can say why.
 *
 * They do NOT call `refreshBbjMini()`. That feed is keyed by club id and these
 * take a union id; a union operator's surface re-reads the pool row it already
 * holds. Calling it with no club in hand would refresh nothing and read as
 * though it had.
 */
export async function setBbjUnionMiniEnabled(
  unionId: string,
  enabled: boolean
): Promise<{ ok: true; enabled: boolean } | { ok: false; reason: string }> {
  try {
    const { data, error } = await supabase.rpc('fn_bbj_set_union_mini_enabled', {
      p_union_id: unionId,
      p_enabled: enabled,
    });
    if (error) {
      reportError(error, 'bbjMiniFeed.union_set_failed', { unionId, enabled });
      return { ok: false, reason: 'request_failed' };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok !== true) {
      return { ok: false, reason: String(row.reason ?? 'refused') };
    }
    return { ok: true, enabled: row.mini_enabled !== false };
  } catch (e) {
    reportError(e, 'bbjMiniFeed.union_set_threw', { unionId, enabled });
    return { ok: false, reason: 'request_failed' };
  }
}

/** The union's reserve floor. See `setBbjUnionMiniEnabled` for why this pair exists. */
export async function setBbjUnionMiniFloor(
  unionId: string,
  floor: number
): Promise<{ ok: true; floor: number } | { ok: false; reason: string; minimum?: number }> {
  try {
    const { data, error } = await supabase.rpc('fn_bbj_set_union_mini_floor', {
      p_union_id: unionId,
      p_floor: floor,
    });
    if (error) {
      reportError(error, 'bbjMiniFeed.union_set_floor_failed', { unionId, floor });
      return { ok: false, reason: 'request_failed' };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    if (row.ok !== true) {
      return {
        ok: false,
        reason: String(row.reason ?? 'refused'),
        minimum: row.minimum === undefined ? undefined : num(row.minimum),
      };
    }
    return { ok: true, floor: num(row.mini_reserve_floor) };
  } catch (e) {
    reportError(e, 'bbjMiniFeed.union_set_floor_threw', { unionId, floor });
    return { ok: false, reason: 'request_failed' };
  }
}

/** Test-only. Never called by the app. */
export function __resetBbjMiniFeedForTests(): void {
  for (const feed of feeds.values()) if (feed.timer !== null) clearInterval(feed.timer);
  feeds.clear();
}
