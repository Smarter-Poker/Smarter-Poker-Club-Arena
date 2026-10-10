/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHERE THIS PROCESS'S LIGHTNING HANDS LIVE (Lightning Phase 6, 2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two maps and a door:
 *
 *   - every LightningHandHost this process is dealing, by instance id, and
 *     by the ROOM (pool_session_id) of each player still shown its hand - the
 *     room a client subscribes to and posts actions against. An instance id
 *     never leaves this file towards a client;
 *   - every room a caller was admitted to through fn_lightning_hand_view_access
 *     (the room is the caller's own pool session), with its live socket count,
 *     which is the presence the matcher's p_disconnected feed reads for
 *     players who watch Lightning from their room rather than an anchor table;
 *   - the door: `authorize` for a WebSocket SUBSCRIBE to a pool_session_id,
 *     `actionEngineFor` for POST /action against one.
 *
 * LightningHosting ties the worker to it: it builds a host for each formed
 * hand, registers it, wakes the worker when a player is freed, and on
 * leadership or worker loss abandons every hand that has not reached
 * settlement (the instance is voided; no chip has moved).
 */
import { supabase } from '../services/supabase/client.js';
import type { TableConnectionAccess } from '../services/TableConnectionAccess.js';
import type { LightningDevicePlatform, PresenceTableReport } from './LightningPresence.js';
import type { LightningPresenceReport } from './LightningPresenceReporter.js';
import { isUuid } from './LightningRpc.js';
import { LightningSeatProxy } from './LightningSeatProxy.js';
import {
  LightningHandHost,
  LightningTimeBankLedger,
  type LightningFormedHand,
  type LightningHandHostDeps,
  type LightningHub,
  type LightningLease,
} from './LightningHandHost.js';
import type { LightningHandBackend } from './LightningHandBackend.js';
import type { LightningAutoRebuyReport } from './LightningAutoRebuy.js';
import type { LightningConfig } from './LightningConfig.js';
import { lightningMetrics, type LightningMetrics } from './LightningMetrics.js';

interface RoomInfo {
  userId: string;
  clusterId: string | null;
  sockets: number;
  /** The device class the room's latest socket reported (Lightning Phase 8). */
  platform?: LightningDevicePlatform | null;
}

/**
 * LIGHTNING PHASE 8: ONE PLAYER, SEVERAL HANDS, ONE QUEUE OF DECISIONS.
 *
 * A player in several Clusters can owe a decision in more than one hand at
 * once. Each owed decision is announced to EVERY Lightning room the player
 * has open here (a private USER_EVENT), so whichever room they are looking
 * at can list it, and retracted the moment it is no longer owed (acted,
 * folded, timed out, the hand ended). Every clock value is the engine's:
 * `deadline_at` is this process's epoch ms and `time_remaining_ms` is
 * computed here at send time. The client orders by them and offers a tap;
 * it never moves the view by itself (CLAUDE.md 10.6).
 */
export type LightningDecisionUrgency = 'normal' | 'high' | 'critical';

/** At or under this, a decision is critical; at or under the next, high. */
export const LIGHTNING_DECISION_CRITICAL_MS = 5_000;
export const LIGHTNING_DECISION_HIGH_MS = 10_000;

export function lightningDecisionUrgency(remainingMs: number): LightningDecisionUrgency {
  if (remainingMs <= LIGHTNING_DECISION_CRITICAL_MS) return 'critical';
  if (remainingMs <= LIGHTNING_DECISION_HIGH_MS) return 'high';
  return 'normal';
}

/** One owed decision, as the host announces it. */
export interface LightningDecision {
  poolSessionId: string;
  handId: string;
  street: string;
  /** Engine epoch ms the decision's clock runs out (time bank included once it is burning). */
  deadlineAt: number;
}

/** How a frame reaches one player's sockets in one room (TableStateHub.sendToUser). */
export type LightningUserEventSink = (
  roomId: string,
  userId: string,
  payload: Record<string, unknown>
) => number;

export interface LightningRegistryDeps {
  /** fn_lightning_hand_view_access(p_pool_session_id, p_user_id). */
  viewAccess?(roomId: string, userId: string): Promise<boolean>;
  /** Close every socket on a room (EngineWebSocketServer.closeRoom); wired at boot. */
  closeRoom?(roomId: string, reason: string): void;
  /** The pool session's owner and Cluster (presence attribution). */
  roomOwner?(roomId: string): Promise<{ playerId: string; clusterId: string } | null>;
  /** `cash_games.cluster_mode` of a Cluster: why a room ended, for its close reason. */
  clusterMode?(clusterId: string): Promise<string | null>;
  /**
   * LIGHTNING PHASE 9: told on TRANSITIONS ONLY - a player's last socket in
   * their room dropped, or their first returned - so the database can keep
   * `disconnected_at` and reap an expired disconnect. Null (the default)
   * reports nothing; the boot wiring passes the real reporter.
   */
  presenceReport?: LightningPresenceReport | null;
  /** Engine clock (injected for tests). */
  now?: () => number;
  /** LIGHTNING PHASE 12: where hand_to_first_render goes (the process metrics otherwise). */
  metrics?: LightningMetrics;
}

/** LIGHTNING PHASE 12: a first hand frame waiting for its room's RENDER_ACK. */
interface PendingRender {
  handId: string;
  userId: string;
  clusterId: string | null;
  sentAtMs: number;
}

/** A first frame unacknowledged this long is no sample (the room was not watching). */
export const LIGHTNING_RENDER_ACK_TTL_MS = 60_000;
/** Most first frames awaiting an ack at once (one per room; memory bound). */
export const LIGHTNING_RENDER_PENDING_MAX = 20_000;

/** The close reason of a room whose player left (or was cashed out of) the pool. */
export const LIGHTNING_SESSION_ENDED_REASON = 'Your Lightning Session Has Ended';
/**
 * The close reason of a room whose Cluster went back to MUST MOVE (Lightning
 * Phase 7): the pool is gone, and the player's seat is at their own table.
 */
export const LIGHTNING_HAS_ENDED_REASON = 'Lightning Has Ended';

export async function lightningClusterMode(clusterId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('cash_games')
    .select('cluster_mode')
    .eq('id', clusterId)
    .maybeSingle();
  if (error) throw new Error(`cash_games cluster_mode read failed: ${error.message}`);
  const mode = (data as { cluster_mode?: unknown } | null)?.cluster_mode;
  return typeof mode === 'string' ? mode : null;
}

const REFUSED: TableConnectionAccess = {
  allowed: false,
  reason: 'table_not_found',
  clubId: null,
  banned: false,
  ipRestricted: false,
};

export async function lightningHandViewAccess(roomId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('fn_lightning_hand_view_access', {
    p_pool_session_id: roomId,
    p_user_id: userId,
  });
  if (error) throw new Error(`fn_lightning_hand_view_access failed: ${error.message}`);
  return data === true;
}

export async function lightningRoomOwner(
  roomId: string
): Promise<{ playerId: string; clusterId: string } | null> {
  const { data } = await supabase
    .from('lightning_pool_session')
    .select('player_id, cluster_id')
    .eq('id', roomId)
    .maybeSingle();
  const row = data as { player_id?: unknown; cluster_id?: unknown } | null;
  return row && isUuid(row.player_id) && isUuid(row.cluster_id)
    ? { playerId: row.player_id, clusterId: row.cluster_id }
    : null;
}

export class LightningRegistry {
  private readonly hosts = new Map<string, LightningHandHost>();
  private readonly hostByRoom = new Map<string, LightningHandHost>();
  private readonly rooms = new Map<string, RoomInfo>();
  private readonly proxies = new Map<string, LightningSeatProxy>();
  private readonly viewAccess: (roomId: string, userId: string) => Promise<boolean>;
  private readonly roomOwner: (
    roomId: string
  ) => Promise<{ playerId: string; clusterId: string } | null>;
  private closeRoom: ((roomId: string, reason: string) => void) | null;
  private readonly presenceReport: LightningPresenceReport | null;
  private sweeping: Promise<number> | null = null;
  private readonly clusterMode: (clusterId: string) => Promise<string | null>;
  /** userId -> handId -> the decision owed there (Lightning Phase 8). */
  private readonly decisions = new Map<string, Map<string, LightningDecision>>();
  private userEventSink: LightningUserEventSink | null = null;
  private readonly clock: () => number;
  /** LIGHTNING PHASE 12: room -> the first frame of its current hand, until acked. */
  private readonly renderPending = new Map<string, PendingRender>();
  private readonly metrics: LightningMetrics;
  /** LIGHTNING PHASE 12: a room's first socket arrived (admission wake). */
  private arrivalListener: ((clusterId: string) => void) | null = null;
  /** LIGHTNING PHASE 13: Cluster -> what its rooms are told about its hold. */
  private readonly clusterStatuses = new Map<string, 'ending' | 'paused'>();

  constructor(deps: LightningRegistryDeps = {}) {
    this.viewAccess = deps.viewAccess ?? lightningHandViewAccess;
    this.roomOwner = deps.roomOwner ?? lightningRoomOwner;
    this.clusterMode = deps.clusterMode ?? lightningClusterMode;
    this.closeRoom = deps.closeRoom ?? null;
    this.presenceReport = deps.presenceReport ?? null;
    this.clock = deps.now ?? Date.now;
    this.metrics = deps.metrics ?? lightningMetrics;
  }

  /**
   * Boot wiring (Lightning Phase 12): told when a room's FIRST socket arrives
   * with a known Cluster - a player joining, or back - so that Cluster's
   * worker runs its next pass soon instead of a pass interval later.
   */
  setArrivalListener(listener: ((clusterId: string) => void) | null): void {
    this.arrivalListener = listener;
  }

  // ─── LIGHTNING PHASE 12: HAND CREATION -> FIRST CLIENT RENDER ───────────

  /**
   * A host sent this room its hand's first frame at `atMs` (engine clock).
   * One entry per room: the next hand in the room replaces an unacked one.
   */
  noteFirstFrame(roomId: string, userId: string, handId: string, atMs: number): void {
    if (!isUuid(roomId) || !isUuid(handId)) return;
    this.renderPending.delete(roomId);
    this.renderPending.set(roomId, {
      handId,
      userId,
      clusterId:
        this.rooms.get(roomId)?.clusterId ?? this.hostByRoom.get(roomId)?.clusterId ?? null,
      sentAtMs: atMs,
    });
    if (this.renderPending.size > LIGHTNING_RENDER_PENDING_MAX) {
      for (const [room, p] of this.renderPending) {
        if (
          this.renderPending.size <= LIGHTNING_RENDER_PENDING_MAX &&
          atMs - p.sentAtMs < LIGHTNING_RENDER_ACK_TTL_MS
        )
          break;
        this.renderPending.delete(room);
      }
    }
  }

  /**
   * The room's socket says it rendered this hand (RENDER_ACK). Only the
   * room's owner can close it, only once, only for the hand that room was
   * sent, and only inside the TTL. The leg is the ENGINE's clock from the
   * first frame to now: the client's timestamps are never used. The frame
   * carries a hand id and nothing else of the hand.
   */
  renderAck(roomId: string, userId: string, handId: unknown): boolean {
    const p = this.renderPending.get(roomId);
    if (!p || typeof handId !== 'string' || p.handId !== handId || p.userId !== userId)
      return false;
    this.renderPending.delete(roomId);
    const ms = this.clock() - p.sentAtMs;
    if (ms < 0 || ms > LIGHTNING_RENDER_ACK_TTL_MS) return false;
    this.metrics.observeLatency('hand_to_first_render', ms, p.clusterId);
    return true;
  }

  /** First frames still waiting for an ack (memory bound checks). */
  get pendingRenderAcks(): number {
    return this.renderPending.size;
  }

  /** Rooms and hosts held (memory bound checks). */
  get sizes(): {
    rooms: number;
    hosts: number;
    hostByRoom: number;
    proxies: number;
    decisions: number;
  } {
    return {
      rooms: this.rooms.size,
      hosts: this.hosts.size,
      hostByRoom: this.hostByRoom.size,
      proxies: this.proxies.size,
      decisions: this.decisions.size,
    };
  }

  /** Boot wiring: how a private frame reaches a player's sockets in a room. */
  setUserEventSink(sink: LightningUserEventSink): void {
    this.userEventSink = sink;
  }

  /** Boot wiring: the transport that can close a room's sockets. */
  setRoomCloser(close: (roomId: string, reason: string) => void): void {
    this.closeRoom = close;
  }

  // ─── HOSTS ──────────────────────────────────────────────────────────────

  register(host: LightningHandHost): void {
    this.hosts.set(host.instanceId, host);
    for (const playerId of host.participantIds()) {
      const room = host.roomOf(playerId);
      if (!room) continue;
      this.hostByRoom.set(room, host);
      const info = this.rooms.get(room);
      if (info) info.clusterId = info.clusterId ?? host.clusterId;
      else this.rooms.set(room, { userId: playerId, clusterId: host.clusterId, sockets: 0 });
    }
  }

  unregister(host: LightningHandHost): void {
    if (this.hosts.get(host.instanceId) === host) this.hosts.delete(host.instanceId);
    for (const [room, h] of [...this.hostByRoom]) {
      if (h !== host) continue;
      this.hostByRoom.delete(room);
      this.pruneRoom(room);
      // A room still holding sockets and not moving to a new hand may be a
      // pool session that just ended: ask, and close it if so.
      if (this.rooms.get(room)?.sockets) void this.checkEndedRoom(room).catch(() => undefined);
    }
  }

  /** A freed player's room now belongs to no hand of this host. */
  releaseRoom(host: LightningHandHost, playerId: string): void {
    const room = host.roomOf(playerId);
    if (room && this.hostByRoom.get(room) === host) {
      this.hostByRoom.delete(room);
      this.pruneRoom(room);
    }
  }

  hasInstance(instanceId: string): boolean {
    return this.hosts.has(instanceId);
  }

  hostForRoom(roomId: string): LightningHandHost | undefined {
    return this.hostByRoom.get(roomId);
  }

  hostsOf(clusterId: string): LightningHandHost[] {
    return [...this.hosts.values()].filter((h) => h.clusterId === clusterId);
  }

  activeHosts(): number {
    return this.hosts.size;
  }

  // ─── ROOMS ──────────────────────────────────────────────────────────────

  /** A pool_session_id this process knows: a live hand, or an admitted caller. */
  isRoom(roomId: string): boolean {
    return this.rooms.has(roomId) || this.hostByRoom.has(roomId);
  }

  /**
   * The connection verdict for a pool_session_id. Called only after the
   * physical table check answered table_not_found, so no real table pays for
   * it. Fails closed: a check that cannot run is check_failed (the client
   * retries), and anything but the owner is table_not_found.
   */
  async authorize(roomId: string, userId: string): Promise<TableConnectionAccess> {
    if (!isUuid(roomId) || !isUuid(userId)) return REFUSED;
    // FIRST-HAND PATH (Lightning Phase 12): a room this process has not seen
    // asks the access door and the owner row together - one round trip, not
    // two. The owner row is attribution only and is used only when admitted.
    const ownerP = this.rooms.has(roomId) ? null : this.roomOwner(roomId);
    ownerP?.catch(() => undefined);
    let ok: boolean;
    try {
      ok = await this.viewAccess(roomId, userId);
    } catch {
      return { ...REFUSED, reason: 'check_failed' };
    }
    if (!ok) {
      // An ended pool session is no room any more: refused as not found, the
      // answer the client treats as 4404, and forgotten here.
      if (!this.hostByRoom.has(roomId)) {
        this.rooms.delete(roomId);
        this.proxies.delete(roomId);
      }
      return REFUSED;
    }
    if (!this.rooms.has(roomId)) {
      let clusterId: string | null = null;
      try {
        const owner = await (ownerP ?? this.roomOwner(roomId));
        if (owner && owner.playerId === userId) clusterId = owner.clusterId;
      } catch {
        /* presence attribution only; the hand host fills it in on its first hand */
      }
      if (!this.rooms.has(roomId)) this.rooms.set(roomId, { userId, clusterId, sockets: 0 });
    }
    // Its own pool session: a seated player's view, of their own room.
    return { allowed: true, reason: 'seated', clubId: null, banned: false, ipRestricted: false };
  }

  connect(roomId: string, userId: string, platform: LightningDevicePlatform | null = null): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    info.sockets++;
    if (platform) info.platform = platform;
    this.hostByRoom.get(roomId)?.notePresence(userId, true);
    // FIRST socket back: a transition, told once (Lightning Phase 9). A second
    // socket in the same room changes nothing the database should hear.
    if (info.sockets === 1 && info.clusterId) {
      this.reportPresence('reconnected', info.clusterId, userId);
      // LIGHTNING PHASE 12: a player arrived in the pool - admission wake.
      try {
        this.arrivalListener?.(info.clusterId);
      } catch {
        /* a listener must never take the registry down */
      }
    }
  }

  disconnect(roomId: string, userId: string): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    const had = info.sockets;
    info.sockets = Math.max(0, info.sockets - 1);
    if (info.sockets === 0) {
      this.hostByRoom.get(roomId)?.notePresence(userId, false);
      // LAST socket gone: the transition the DB reaper's clock starts on.
      if (had > 0 && info.clusterId) this.reportPresence('disconnected', info.clusterId, userId);
    }
    this.pruneRoom(roomId);
  }

  private reportPresence(
    kind: 'disconnected' | 'reconnected',
    clusterId: string,
    userId: string
  ): void {
    try {
      if (kind === 'disconnected') this.presenceReport?.disconnected(clusterId, userId);
      else this.presenceReport?.reconnected(clusterId, userId);
    } catch {
      /* a reporter must never take the registry down */
    }
  }

  isConnected(playerId: string, roomId: string): boolean {
    const info = this.rooms.get(roomId);
    return !!info && info.userId === playerId && info.sockets > 0;
  }

  /**
   * Does this player hold at least one live socket in any of this Cluster's
   * rooms here? The boot reconciliation pass (Lightning Phase 9 remediation)
   * asks this to find the open pool sessions the restarted engine will never
   * see a socket drop for.
   */
  hasClusterSocket(clusterId: string, playerId: string): boolean {
    for (const info of this.rooms.values()) {
      if (info.clusterId === clusterId && info.userId === playerId && info.sockets > 0) return true;
    }
    return false;
  }

  private pruneRoom(roomId: string): void {
    const info = this.rooms.get(roomId);
    if (info && info.sockets === 0 && !this.hostByRoom.has(roomId)) {
      this.rooms.delete(roomId);
      this.proxies.delete(roomId);
      this.renderPending.delete(roomId);
    }
  }

  /** Presence for the matcher: rooms with a known Cluster, connected or not. */
  *presenceReports(): Iterable<PresenceTableReport> {
    for (const [room, info] of this.rooms) {
      if (!info.clusterId) continue;
      yield {
        tableId: room,
        clusterId: info.clusterId,
        players: [
          {
            userId: info.userId,
            presence: info.sockets > 0 ? 'connected' : 'disconnected',
            ...(info.platform ? { platform: info.platform } : {}),
          },
        ],
      };
    }
  }

  /** POST /action's engine for a pool_session_id. */
  actionEngineFor(roomId: string): LightningSeatProxy | undefined {
    if (!this.isRoom(roomId)) return undefined;
    let proxy = this.proxies.get(roomId);
    if (!proxy) {
      proxy = new LightningSeatProxy(roomId, this);
      this.proxies.set(roomId, proxy);
    }
    return proxy;
  }

  /**
   * A room whose pool session has ENDED is closed: its record and proxy are
   * forgotten and every socket on it is told 4404 (single-table) or
   * TABLE_NOT_FOUND (mux), which the client reads as "this session is over".
   * Only a room with sockets and no hand is asked; a check that cannot run
   * leaves the room as it is. True when the room was closed.
   *
   * THE REASON SAYS WHICH ENDING (Lightning Phase 7). A room whose Cluster is
   * back in MUST MOVE says "Lightning Has Ended"; any other ended session
   * keeps "Your Lightning Session Has Ended". The client does not trust the
   * words (the mux replaces them with a code): it asks fn_lightning_my_session,
   * which names the seat to go back to. A mode that cannot be read is the
   * ordinary ending: the room is closed all the same.
   */
  private async checkEndedRoom(roomId: string): Promise<boolean> {
    const info = this.rooms.get(roomId);
    if (!info || info.sockets === 0 || this.hostByRoom.has(roomId)) return false;
    let ok: boolean;
    try {
      ok = await this.viewAccess(roomId, info.userId);
    } catch {
      return false;
    }
    if (ok || this.hostByRoom.has(roomId) || this.rooms.get(roomId) !== info) return false;
    const reason = await this.endedReason(roomId, info.clusterId);
    // Re-checked after the await: a room taken by a new hand is not closed.
    if (this.hostByRoom.has(roomId) || this.rooms.get(roomId) !== info) return false;
    this.rooms.delete(roomId);
    this.proxies.delete(roomId);
    try {
      this.closeRoom?.(roomId, reason);
    } catch {
      /* the transport must never take the registry down */
    }
    return true;
  }

  private async endedReason(roomId: string, clusterId: string | null): Promise<string> {
    try {
      const cluster = clusterId ?? (await this.roomOwner(roomId))?.clusterId ?? null;
      if (!cluster) return LIGHTNING_SESSION_ENDED_REASON;
      return (await this.clusterMode(cluster)) === 'must_move'
        ? LIGHTNING_HAS_ENDED_REASON
        : LIGHTNING_SESSION_ENDED_REASON;
    } catch {
      return LIGHTNING_SESSION_ENDED_REASON;
    }
  }

  /**
   * The supervisor's five-second tick: every room with live sockets and no
   * hand here is checked, and a room whose pool session ended is closed.
   * One sweep at a time; answers how many rooms it closed.
   */
  sweepEndedRooms(): Promise<number> {
    if (this.sweeping) return this.sweeping;
    const run = (async () => {
      let closed = 0;
      for (const [room, info] of [...this.rooms]) {
        if (info.sockets === 0 || this.hostByRoom.has(room)) continue;
        if (await this.checkEndedRoom(room)) closed++;
      }
      return closed;
    })();
    const tracked = run.finally(() => {
      if (this.sweeping === tracked) this.sweeping = null;
    });
    this.sweeping = tracked;
    return tracked;
  }

  /** On (re)connect / RESYNC: the player's own cards, again, and every decision they owe. */
  rePushHoleCards(roomId: string, userId: string): void {
    this.hostByRoom.get(roomId)?.rePushHoleCards(userId);
    this.rePushDecisions(roomId, userId);
    this.rePushClusterStatus(roomId, userId);
  }

  // ─── LIGHTNING PHASE 13: WHAT A HELD CLUSTER'S ROOMS ARE TOLD ──────────

  /** The private frame naming a Cluster's hold. Never a card, a stack or another player. */
  clusterStatusFrame(clusterId: string): Record<string, unknown> {
    return {
      type: 'lightning_cluster_status',
      cluster_id: clusterId,
      status: this.clusterStatuses.get(clusterId) ?? null,
    };
  }

  clusterStatusOf(clusterId: string): 'ending' | 'paused' | null {
    return this.clusterStatuses.get(clusterId) ?? null;
  }

  /**
   * The supervisor's word on a Cluster's hold: 'ending' while it drains back
   * to MUST MOVE, 'paused' while an operator holds it, null when it forms
   * again (or has left Lightning). Every room of the Cluster here is told at
   * once, and a room that connects later is told on its RESYNC. Every room is
   * told alike, whoever owns it.
   */
  setClusterStatus(clusterId: string, status: 'ending' | 'paused' | null): void {
    if (!isUuid(clusterId)) return;
    const prev = this.clusterStatuses.get(clusterId) ?? null;
    if (prev === status) return;
    if (status === null) this.clusterStatuses.delete(clusterId);
    else this.clusterStatuses.set(clusterId, status);
    const frame = this.clusterStatusFrame(clusterId);
    for (const [room, info] of this.rooms) {
      const cluster = info.clusterId ?? this.hostByRoom.get(room)?.clusterId ?? null;
      if (cluster === clusterId) this.sendUserEvent(room, info.userId, frame);
    }
  }

  private rePushClusterStatus(roomId: string, userId: string): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    const cluster = info.clusterId ?? this.hostByRoom.get(roomId)?.clusterId ?? null;
    if (!cluster || !this.clusterStatuses.has(cluster)) return;
    this.sendUserEvent(roomId, userId, this.clusterStatusFrame(cluster));
  }

  // ─── THE DECISION QUEUE (Lightning Phase 8) ─────────────────────────────

  /** Every Lightning room this player has here (any Cluster). */
  roomsOfUser(userId: string): string[] {
    const out: string[] = [];
    for (const [room, info] of this.rooms) if (info.userId === userId) out.push(room);
    return out.sort();
  }

  /** The decisions a player owes right now, soonest deadline first. */
  openDecisions(userId: string): LightningDecision[] {
    const mine = this.decisions.get(userId);
    return mine ? [...mine.values()].sort((a, b) => a.deadlineAt - b.deadlineAt) : [];
  }

  /** The `lightning_decision` frame for one decision, with the clock as of now. */
  decisionFrame(d: LightningDecision): Record<string, unknown> {
    const remaining = Math.max(0, d.deadlineAt - this.clock());
    return {
      type: 'lightning_decision',
      pool_session_id: d.poolSessionId,
      hand_id: d.handId,
      street: d.street,
      time_remaining_ms: remaining,
      deadline_at: d.deadlineAt,
      urgency: lightningDecisionUrgency(remaining),
      server_now: this.clock(),
    };
  }

  /** A decision is owed (or its clock moved, e.g. the time bank started): tell every room. */
  announceDecision(userId: string, decision: LightningDecision): void {
    if (!isUuid(userId) || !decision.handId) return;
    let mine = this.decisions.get(userId);
    if (!mine) {
      mine = new Map();
      this.decisions.set(userId, mine);
    }
    mine.set(decision.handId, { ...decision });
    const frame = this.decisionFrame(decision);
    for (const room of this.roomsOfUser(userId)) this.sendUserEvent(room, userId, frame);
  }

  /** No longer owed (acted, folded, timed out, hand over): retract it everywhere, once. */
  clearDecision(userId: string, handId: string, reason: string): void {
    const mine = this.decisions.get(userId);
    const d = mine?.get(handId);
    if (!mine || !d) return;
    mine.delete(handId);
    if (mine.size === 0) this.decisions.delete(userId);
    const frame = {
      type: 'lightning_decision_cleared',
      pool_session_id: d.poolSessionId,
      hand_id: handId,
      reason,
    };
    for (const room of this.roomsOfUser(userId)) this.sendUserEvent(room, userId, frame);
  }

  private rePushDecisions(roomId: string, userId: string): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    for (const d of this.openDecisions(userId)) {
      if (d.deadlineAt > this.clock()) this.sendUserEvent(roomId, userId, this.decisionFrame(d));
    }
  }

  private sendUserEvent(roomId: string, userId: string, payload: Record<string, unknown>): void {
    try {
      this.userEventSink?.(roomId, userId, payload);
    } catch {
      /* the transport must never take the registry down */
    }
  }
}

export interface LightningHostingDeps {
  registry: LightningRegistry;
  backend: LightningHandBackend;
  hub: LightningHub;
  leaseFor(hostTableId: string): LightningLease | null;
  metrics?: LightningMetrics;
  /**
   * LIGHTNING PHASE 10: asked once per settled hand, between hands only,
   * about the players that boundary releases (LightningAutoRebuy). Null (the
   * default) asks nothing; the boot wiring passes the real executor. The
   * database does all money movement and validation - the engine only asks.
   */
  autoRebuy?: LightningAutoRebuyReport | null;
  /** Injected for tests (and the Phase 12 load suite's in-memory world). */
  hostOptions?: Partial<
    Pick<
      LightningHandHostDeps,
      'timer' | 'sleep' | 'now' | 'logger' | 'horseLane' | 'jackpot' | 'postCommitBudgetMs'
    >
  >;
}

/** The longest a Cluster waits after consecutive abandons before forming again. */
export const LIGHTNING_ABANDON_BACKOFF_MAX_MS = 30_000;
const ABANDON_BACKOFF_BASE_MS = 500;

/** The worker's side of the registry: build, register and fence hosts. */
export class LightningHosting {
  private readonly timeBanks = new Map<string, LightningTimeBankLedger>();
  /** Per Cluster: consecutive abandoned hands, and no forming before `until`. */
  private readonly abandonBackoff = new Map<string, { count: number; until: number }>();

  constructor(private readonly deps: LightningHostingDeps) {
    // The decision queue's frames travel the hub's private per-player path.
    deps.registry.setUserEventSink((room, user, payload) =>
      deps.hub.sendToUser(room, user, payload)
    );
  }

  /**
   * A host already exists for this instance - registered (dealing), or still
   * starting (pending) - so a replayed pass can never start a second one.
   */
  hasInstance(instanceId: string): boolean {
    if (this.deps.registry.hasInstance(instanceId)) return true;
    for (const h of this.pending) if (h.instanceId === instanceId) return true;
    return false;
  }

  /** The verified lease this process holds on a host table, or null. */
  leaseFor(hostTableId: string): LightningLease | null {
    return this.deps.leaseFor(hostTableId);
  }

  /**
   * Epoch ms before which the Cluster must not form (0 = now). A hand that
   * is abandoned doubles the wait, from half a second up to thirty; one that
   * settles clears it. An abandon never wakes the worker, so a Cluster whose
   * hands keep failing cannot spin match_and_form in a tight loop.
   */
  formBackoffUntil(clusterId: string): number {
    return this.abandonBackoff.get(clusterId)?.until ?? 0;
  }

  /**
   * LIGHTNING PHASE 13: this Cluster's hands still being dealt here (started
   * and not finished, whatever their state). The drain's progress report.
   */
  handsInFlight(clusterId: string): number {
    let n = 0;
    for (const h of this.pending) if (h.clusterId === clusterId) n++;
    return n;
  }

  private noteOutcome(clusterId: string, lifecycle: string): void {
    const now = this.deps.hostOptions?.now?.() ?? Date.now();
    if (lifecycle === 'complete') {
      this.abandonBackoff.delete(clusterId);
      return;
    }
    if (lifecycle !== 'abandoned') return;
    const prev = this.abandonBackoff.get(clusterId)?.count ?? 0;
    const count = prev + 1;
    const wait = Math.min(
      LIGHTNING_ABANDON_BACKOFF_MAX_MS,
      ABANDON_BACKOFF_BASE_MS * 2 ** Math.min(count - 1, 10)
    );
    this.abandonBackoff.set(clusterId, { count, until: now + wait });
  }

  /** Deal one formed hand. Returns the host (already starting). */
  startHand(
    hand: LightningFormedHand,
    config: LightningConfig,
    wake: () => void,
    onClusterFrozen?: (clusterId: string) => void,
    /**
     * LIGHTNING PHASE 13: the worker's CURRENT config, read at the action door
     * so an operator's flag change reaches a hand already being dealt. Absent,
     * the config the hand was formed under stands.
     */
    liveConfig?: () => LightningConfig
  ): LightningHandHost {
    let ledger = this.timeBanks.get(hand.clusterId);
    if (!ledger) {
      ledger = new LightningTimeBankLedger(this.deps.backend, hand.clusterId);
      this.timeBanks.set(hand.clusterId, ledger);
    }
    const registry = this.deps.registry;
    const host: LightningHandHost = new LightningHandHost(hand, {
      backend: this.deps.backend,
      hub: this.deps.hub,
      leaseFor: this.deps.leaseFor,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      dealWindowMs: config.dealWindowMs,
      timeBanks: ledger,
      metrics: this.deps.metrics ?? lightningMetrics,
      // LIGHTNING PHASE 13: LIGHTNING FOLD and FOLD & WATCH flags, read live.
      foldFlags: () => {
        const r = (liveConfig?.() ?? config).rollout;
        return { fastFold: r?.fastFold !== false, foldWatch: r?.foldWatch !== false };
      },
      isConnected: (playerId, roomId) => registry.isConnected(playerId, roomId),
      onPlayerReleased: (playerId, why) => {
        // A FOLDED player is free while the hand plays on: match them now.
        // Everyone released at the hand's end waits for onFinished, which
        // wakes only for a settled hand - never for an abandon.
        if (why === 'fast' || why === 'normal') {
          registry.releaseRoom(host, playerId);
          wake();
        }
      },
      onDealing: (h) => registry.register(h),
      // LIGHTNING PHASE 12: hand_to_first_render starts at the first frame.
      onFirstFrame: (playerId, roomId, handId, atMs) =>
        registry.noteFirstFrame(roomId, playerId, handId, atMs),
      onDecision: (playerId, decision, reason) => {
        if (decision) registry.announceDecision(playerId, decision);
        else registry.clearDecision(playerId, host.currentHandId, reason ?? 'cleared');
      },
      onClusterFrozen: (clusterId) => onClusterFrozen?.(clusterId),
      // LIGHTNING PHASE 10: the settled boundary reaches the auto-rebuy
      // executor with this hand's Cluster and the config the pass ran on.
      // Config off is a no-op inside the executor; absent executor, nothing.
      onHandSettled: (settled) =>
        this.deps.autoRebuy?.onHandSettled({
          clusterId: hand.clusterId,
          config: config.autoRebuy,
          ...settled,
        }),
      onFinished: (h) => {
        registry.unregister(h);
        this.noteOutcome(h.clusterId, h.lifecycle);
        if (h.lifecycle === 'complete') wake();
      },
      ...this.deps.hostOptions,
    });
    // Registered by onDealing, once the participants (and so the rooms) are known.
    void host.start();
    this.pending.add(host);
    void host
      .whenFinished()
      .finally(() => this.pending.delete(host))
      .catch(() => undefined);
    return host;
  }

  private readonly pending = new Set<LightningHandHost>();

  /** Leadership or worker lost: every unsettled hand of the Cluster is voided. */
  async abortCluster(clusterId: string, reason: string): Promise<void> {
    const hosts = [...this.pending].filter((h) => h.clusterId === clusterId);
    await Promise.allSettled(hosts.map((h) => h.abort(reason)));
  }

  async abortAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.pending].map((h) => h.abort(reason)));
  }
}
