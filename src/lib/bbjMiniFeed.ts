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
}

export type BbjMiniListener = (snapshot: BbjMiniSnapshot) => void;

/** Sixty seconds: configuration plus a reserve that moves on hits, not on hands. */
export const BBJ_MINI_POLL_MS = 60_000;

interface ClubFeed {
  listeners: Set<BbjMiniListener>;
  timer: ReturnType<typeof setInterval> | null;
  last: BbjMiniSnapshot | null;
  reading: boolean;
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
  try {
    const { data, error } = await supabase.rpc('fn_bbj_mini_for_club', { p_club_id: clubId });
    if (error) {
      reportError(error, 'bbjMiniFeed.read_failed', { clubId });
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) return;
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
    };
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
export function watchBbjMini(clubId: string, listener: BbjMiniListener): () => void {
  if (!clubId) return () => undefined;
  hookVisibility();

  let feed = feeds.get(clubId);
  if (!feed) {
    feed = { listeners: new Set(), timer: null, last: null, reading: false };
    feeds.set(clubId, feed);
  }
  const owned = feed;
  owned.listeners.add(listener);
  if (owned.last) listener(owned.last);

  if (owned.timer === null) {
    void readOnce(clubId, owned);
    owned.timer = setInterval(() => tick(clubId, owned), BBJ_MINI_POLL_MS);
  }

  return () => {
    owned.listeners.delete(listener);
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

/** Test-only. Never called by the app. */
export function __resetBbjMiniFeedForTests(): void {
  for (const feed of feeds.values()) if (feed.timer !== null) clearInterval(feed.timer);
  feeds.clear();
}
