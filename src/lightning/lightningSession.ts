/**
 * LIGHTNING PHASE 6: WHO IS IN THE POOL, AND WHICH ROOM IS THEIRS.
 *
 * A Lightning player does not sit at a table. They hold one POOL SESSION for
 * the Cluster, and the engine deals them hand after hand into one room whose
 * id is that pool session's id. This module is the client's whole knowledge of
 * that fact:
 *
 *   - `fetchMyLightningSession` asks the database (fn_lightning_my_session)
 *     whether the caller holds a pool session in a Cluster. The answer never
 *     names an instance: instances are the engine's business, not the player's.
 *   - the REGISTRY remembers which room ids are pool sessions, so the table
 *     view mounted on one knows not to treat it as a `tables` row. It lives in
 *     memory and in sessionStorage, so a reload at the table keeps it.
 *   - `fetchLightningClusterMeta` reads what the felt prints (name, blinds,
 *     variant, seats) from the Cluster's own `cash_games` row, never from a
 *     `tables` row, because a pool session has none.
 */
import { useSyncExternalStore } from 'react';
import { supabase } from '../lib/supabase';
import { isUUID } from '../utils/clubIdResolver';
import { clusterModeDisplay } from './lightningLobby';

/** fn_lightning_my_session, as the client reads it. */
export interface LightningMySession {
  poolSessionId: string | null;
  state: string | null;
  clusterMode: string | null;
  stack: number | null;
  inHand: boolean;
  handId: string | null;
  /**
   * The seat the chips actually sit on. A pool session holds no seat of its
   * own: the player's money stays on their anchor seat at a real table, so a
   * leave, a cash out or an add-on is addressed there, never to the room.
   */
  anchorTableId: string | null;
  seatNumber: number | null;
  occupancyId: string | null;
}

/** Pool session states that mean the session is over and holds no room. */
const ENDED_POOL_SESSION_STATES = new Set(['closed', 'ended', 'left', 'cashed_out', 'expired']);

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Read the RPC's answer defensively: a missing or malformed field is "not known", never a guess. */
export function parseLightningMySession(raw: unknown): LightningMySession {
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') {
    return {
      poolSessionId: null,
      state: null,
      clusterMode: null,
      stack: null,
      inHand: false,
      handId: null,
      anchorTableId: null,
      seatNumber: null,
      occupancyId: null,
    };
  }
  const id = text(row.pool_session_id);
  const anchor = text(row.anchor_table_id);
  const occupancy = text(row.occupancy_id);
  const seat = num(row.seat_number);
  return {
    poolSessionId: id && isUUID(id) ? id : null,
    state: text(row.state),
    clusterMode: text(row.cluster_mode),
    stack: num(row.stack),
    inHand: row.in_hand === true,
    handId: text(row.hand_id),
    anchorTableId: anchor && isUUID(anchor) ? anchor : null,
    seatNumber: seat !== null && Number.isInteger(seat) && seat >= 1 ? seat : null,
    occupancyId: occupancy && isUUID(occupancy) ? occupancy : null,
  };
}

/** The caller holds a pool session whose room can be opened. */
export function hasLightningRoom(session: LightningMySession | null | undefined): boolean {
  if (!session || !session.poolSessionId) return false;
  return !ENDED_POOL_SESSION_STATES.has(String(session.state ?? '').toLowerCase());
}

export async function fetchMyLightningSession(clusterId: string): Promise<LightningMySession> {
  const { data, error } = await supabase.rpc('fn_lightning_my_session', {
    p_cluster_id: clusterId,
  });
  if (error) throw error;
  return parseLightningMySession(data);
}

// ─── The anchor seat: where a leave and an add-on are addressed ────────────

export interface LightningAnchorSeat {
  anchorTableId: string;
  seatNumber: number;
  occupancyId: string;
}

/** The anchor seat of an open pool session, or null when any part is unknown. */
export function lightningAnchorSeat(
  session: LightningMySession | null | undefined
): LightningAnchorSeat | null {
  if (!session || !hasLightningRoom(session)) return null;
  if (!session.anchorTableId || session.seatNumber === null || !session.occupancyId) return null;
  return {
    anchorTableId: session.anchorTableId,
    seatNumber: session.seatNumber,
    occupancyId: session.occupancyId,
  };
}

/**
 * Read the caller's anchor seat in a Cluster fresh from the database. Asked at
 * the moment of a leave or an add-on, never cached: the anchor is the one fact
 * a cash out must not get wrong. Throws when the read fails, so a caller can
 * tell "no seat" (null) from "could not ask" (an error).
 */
export async function fetchLightningAnchorSeat(
  clusterId: string
): Promise<LightningAnchorSeat | null> {
  return lightningAnchorSeat(await fetchMyLightningSession(clusterId));
}

/** What a leave from a Lightning room during a live hand tells the player. */
export const LIGHTNING_LEAVE_QUEUED_TEXT =
  'Your Leave Is Queued. You Will Be Cashed Out When This Hand Ends.';

// ─── The Cluster's own description ─────────────────────────────────────────

export interface LightningClusterMeta {
  clusterId: string;
  clubId: string | null;
  name: string;
  variant: string;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  clusterMode: string | null;
  enabled: boolean;
}

export function parseLightningClusterMeta(raw: unknown): LightningClusterMeta | null {
  const row = raw as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object') return null;
  const id = text(row.id);
  if (!id) return null;
  const handedness = num(row.handedness);
  return {
    clusterId: id,
    clubId: text(row.club_id),
    name: text(row.name) ?? 'Lightning',
    variant: text(row.variant) ?? 'nlh',
    smallBlind: num(row.sb) ?? 0,
    bigBlind: num(row.bb) ?? 0,
    maxPlayers: handedness && handedness >= 2 && handedness <= 10 ? handedness : 6,
    clusterMode: text(row.cluster_mode),
    enabled: row.enabled !== false,
  };
}

const LIGHTNING_CLUSTER_META_COLUMNS =
  'id, club_id, name, variant, sb, bb, handedness, cluster_mode, enabled';

export async function fetchLightningClusterMeta(
  clusterId: string
): Promise<LightningClusterMeta | null> {
  const { data, error } = await supabase
    .from('cash_games')
    .select(LIGHTNING_CLUSTER_META_COLUMNS)
    .eq('id', clusterId)
    .maybeSingle();
  if (error) throw error;
  return parseLightningClusterMeta(data);
}

// ─── The registry of pool-session rooms ────────────────────────────────────

export interface LightningPoolEntry {
  poolSessionId: string;
  clusterId: string;
  meta: LightningClusterMeta | null;
}

export const LIGHTNING_REGISTRY_STORAGE_KEY = 'ca.lightning.pool-sessions.v1';

const registry = new Map<string, LightningPoolEntry>();
const listeners = new Set<() => void>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw =
      typeof sessionStorage !== 'undefined'
        ? sessionStorage.getItem(LIGHTNING_REGISTRY_STORAGE_KEY)
        : null;
    if (!raw) return;
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows)) return;
    for (const r of rows as LightningPoolEntry[]) {
      if (r && isUUID(r.poolSessionId) && isUUID(r.clusterId)) {
        registry.set(r.poolSessionId, {
          poolSessionId: r.poolSessionId,
          clusterId: r.clusterId,
          meta: r.meta ?? null,
        });
      }
    }
  } catch {
    // Storage unavailable or corrupt: the registry starts empty, which is the
    // same as a first visit. The Lightning route registers again on its way in.
  }
}

function persist(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(LIGHTNING_REGISTRY_STORAGE_KEY, JSON.stringify([...registry.values()]));
  } catch {
    // A full or blocked storage keeps the in-memory registry, which is what
    // this page load needs.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function registerLightningPoolSession(entry: LightningPoolEntry): void {
  if (!isUUID(entry.poolSessionId) || !isUUID(entry.clusterId)) return;
  hydrate();
  const prev = registry.get(entry.poolSessionId);
  const next: LightningPoolEntry = {
    poolSessionId: entry.poolSessionId,
    clusterId: entry.clusterId,
    meta: entry.meta ?? prev?.meta ?? null,
  };
  if (
    prev &&
    prev.clusterId === next.clusterId &&
    JSON.stringify(prev.meta) === JSON.stringify(next.meta)
  ) {
    return;
  }
  registry.set(entry.poolSessionId, next);
  persist();
  emit();
}

export function getLightningPoolSession(id: string | null | undefined): LightningPoolEntry | null {
  if (!id) return null;
  hydrate();
  return registry.get(id) ?? null;
}

/** Tests only: drop the in-memory registry and read storage again on next use. */
export function resetLightningRegistryForTests(): void {
  registry.clear();
  hydrated = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Is this room id a Lightning pool session, and whose? Null for every table,
 * which is every room in production today.
 */
export function useLightningPoolSession(id: string | null | undefined): LightningPoolEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => getLightningPoolSession(id),
    () => getLightningPoolSession(id)
  );
}

// ─── A room opened from a new tab or a shared link ─────────────────────────
/*
 * The registry lives in this tab's sessionStorage, so a new tab, a shared link
 * or a bookmark arrives knowing nothing, and the room id has no `tables` row.
 * Before the table view may say a room does not exist, it asks here. The pool
 * session table is not readable from a browser, so the question is put the
 * way the database allows: for each Cluster that can hold a pool session,
 * fn_lightning_my_session answers whether the caller's open session in it is
 * this room. No Cluster is Lightning today, so the list is empty and the
 * answer is an immediate "no".
 */

/** Cluster modes in which a pool session can still be open. */
export const LIGHTNING_ROOM_CLUSTER_MODES = [
  'pending_on',
  'lightning',
  'pending_off',
  'draining',
  'paused',
  'frozen',
] as const;

/** How many such Clusters one lookup asks about. */
export const LIGHTNING_ROOM_SEARCH_LIMIT = 50;

export async function findMyLightningRoom(roomId: string): Promise<LightningPoolEntry | null> {
  if (!isUUID(roomId)) return null;
  const known = getLightningPoolSession(roomId);
  if (known) return known;
  const { data, error } = await supabase
    .from('cash_games')
    .select(LIGHTNING_CLUSTER_META_COLUMNS)
    .in('cluster_mode', [...LIGHTNING_ROOM_CLUSTER_MODES])
    .limit(LIGHTNING_ROOM_SEARCH_LIMIT);
  if (error) throw error;
  const clusters = (Array.isArray(data) ? data : [])
    .map((r) => parseLightningClusterMeta(r))
    .filter((m): m is LightningClusterMeta => m !== null && isUUID(m.clusterId));
  const answers = await Promise.all(
    clusters.map(async (meta) => {
      try {
        return { meta, session: await fetchMyLightningSession(meta.clusterId) };
      } catch {
        return { meta, session: null };
      }
    })
  );
  const hit = answers.find(
    (a) => a.session && hasLightningRoom(a.session) && a.session.poolSessionId === roomId
  );
  if (!hit) return null;
  const entry: LightningPoolEntry = {
    poolSessionId: roomId,
    clusterId: hit.meta.clusterId,
    meta: hit.meta,
  };
  registerLightningPoolSession(entry);
  return getLightningPoolSession(roomId) ?? entry;
}

/**
 * The engine names a pool-session room's Cluster in its snapshot
 * (`lightning.cluster_id`). A room the registry does not know yet is known
 * from that moment; null when the snapshot carries no Cluster.
 */
export function lightningClusterIdOfSnapshot(snapshot: unknown): string | null {
  const lightning = (snapshot as { lightning?: { cluster_id?: unknown } | null } | null)?.lightning;
  const id = lightning && typeof lightning.cluster_id === 'string' ? lightning.cluster_id : null;
  return id && isUUID(id) ? id : null;
}

// ─── JOIN LIGHTNING in progress ────────────────────────────────────────────
/*
 * JOIN LIGHTNING runs the Cluster's existing door (fn_cash_game_join) and the
 * table's existing buy-in. The database moves a player who buys in at a
 * Lightning Cluster into its pool. The intent below remembers, for that one
 * anchor table, that the player asked for Lightning, so the table view can
 * carry THIS tab on to the pool-session room once the pool session exists:
 * the player's own chair moved, exactly as a must-move re-points a tab.
 */

export const LIGHTNING_INTENT_STORAGE_KEY = 'ca.lightning.entry-intent.v1';
/** An intent older than this is forgotten: the player walked away from it. */
export const LIGHTNING_INTENT_TTL_MS = 15 * 60_000;

interface LightningEntryIntent {
  anchorTableId: string;
  clusterId: string;
  at: number;
}

function readIntents(): LightningEntryIntent[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(LIGHTNING_INTENT_STORAGE_KEY);
    const rows = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(rows) ? (rows as LightningEntryIntent[]) : [];
  } catch {
    return [];
  }
}

function writeIntents(rows: LightningEntryIntent[]): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(LIGHTNING_INTENT_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Storage blocked: the intent is lost and the player reaches the pool
    // through the Lightning route instead, which always works.
  }
}

export function setLightningEntryIntent(
  anchorTableId: string,
  clusterId: string,
  now = Date.now()
): void {
  if (!isUUID(anchorTableId) || !isUUID(clusterId)) return;
  const rows = readIntents().filter(
    (r) => r.anchorTableId !== anchorTableId && now - Number(r.at) < LIGHTNING_INTENT_TTL_MS
  );
  rows.push({ anchorTableId, clusterId, at: now });
  writeIntents(rows);
}

export function getLightningEntryIntent(
  anchorTableId: string | null | undefined,
  now = Date.now()
): string | null {
  if (!anchorTableId) return null;
  const hit = readIntents().find((r) => r.anchorTableId === anchorTableId);
  if (!hit || now - Number(hit.at) >= LIGHTNING_INTENT_TTL_MS || !isUUID(hit.clusterId)) {
    return null;
  }
  return hit.clusterId;
}

export function clearLightningEntryIntent(anchorTableId: string): void {
  const rows = readIntents();
  const kept = rows.filter((r) => r.anchorTableId !== anchorTableId);
  if (kept.length !== rows.length) writeIntents(kept);
}

// ─── The Lightning route's decision ────────────────────────────────────────

export type LightningEntryDecision =
  | { kind: 'open'; poolSessionId: string }
  | { kind: 'entry'; joinLabel: 'Join Lightning' | 'Join Game'; lightning: boolean };

/**
 * A caller with a live pool session goes straight into its room. Anyone else
 * is shown the Cluster's entry: JOIN LIGHTNING while the Cluster runs as
 * Lightning, JOIN GAME otherwise (the same door either way).
 */
export function lightningEntryDecision(
  session: LightningMySession | null,
  meta: LightningClusterMeta | null
): LightningEntryDecision {
  if (session && hasLightningRoom(session) && session.poolSessionId) {
    return { kind: 'open', poolSessionId: session.poolSessionId };
  }
  const mode = meta?.clusterMode ?? session?.clusterMode ?? null;
  /* JOIN LIGHTNING only while the Cluster IS Lightning. On its way in
     (pending_on) or out (pending_off, draining) the door is JOIN GAME. */
  const lightning = clusterModeDisplay(mode).joinLightning;
  return { kind: 'entry', joinLabel: lightning ? 'Join Lightning' : 'Join Game', lightning };
}

/** The table-view path for a pool-session room, with the tab's name and stakes. */
export function lightningRoomPath(
  poolSessionId: string,
  meta: LightningClusterMeta | null
): string {
  const params = new URLSearchParams();
  if (meta) {
    params.set('name', meta.name);
    if (meta.smallBlind > 0 && meta.bigBlind > 0) {
      params.set('stakes', `${Number(meta.smallBlind)}/${Number(meta.bigBlind)}`);
    }
  }
  const q = params.toString();
  return `/table/${poolSessionId}${q ? `?${q}` : ''}`;
}
