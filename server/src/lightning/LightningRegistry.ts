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
import type { PresenceTableReport } from './LightningPresence.js';
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
import type { LightningConfig } from './LightningConfig.js';
import { lightningMetrics, type LightningMetrics } from './LightningMetrics.js';

interface RoomInfo {
  userId: string;
  clusterId: string | null;
  sockets: number;
}

export interface LightningRegistryDeps {
  /** fn_lightning_hand_view_access(p_pool_session_id, p_user_id). */
  viewAccess?(roomId: string, userId: string): Promise<boolean>;
  /** The pool session's owner and Cluster (presence attribution). */
  roomOwner?(roomId: string): Promise<{ playerId: string; clusterId: string } | null>;
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

  constructor(deps: LightningRegistryDeps = {}) {
    this.viewAccess = deps.viewAccess ?? lightningHandViewAccess;
    this.roomOwner = deps.roomOwner ?? lightningRoomOwner;
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
        const owner = await this.roomOwner(roomId);
        if (owner && owner.playerId === userId) clusterId = owner.clusterId;
      } catch {
        /* presence attribution only; the hand host fills it in on its first hand */
      }
      if (!this.rooms.has(roomId)) this.rooms.set(roomId, { userId, clusterId, sockets: 0 });
    }
    // Its own pool session: a seated player's view, of their own room.
    return { allowed: true, reason: 'seated', clubId: null, banned: false, ipRestricted: false };
  }

  connect(roomId: string, userId: string): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    info.sockets++;
    this.hostByRoom.get(roomId)?.notePresence(userId, true);
  }

  disconnect(roomId: string, userId: string): void {
    const info = this.rooms.get(roomId);
    if (!info || info.userId !== userId) return;
    info.sockets = Math.max(0, info.sockets - 1);
    if (info.sockets === 0) this.hostByRoom.get(roomId)?.notePresence(userId, false);
    this.pruneRoom(roomId);
  }

  isConnected(playerId: string, roomId: string): boolean {
    const info = this.rooms.get(roomId);
    return !!info && info.userId === playerId && info.sockets > 0;
  }

  private pruneRoom(roomId: string): void {
    const info = this.rooms.get(roomId);
    if (info && info.sockets === 0 && !this.hostByRoom.has(roomId)) {
      this.rooms.delete(roomId);
      this.proxies.delete(roomId);
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
          { userId: info.userId, presence: info.sockets > 0 ? 'connected' : 'disconnected' },
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

  /** On (re)connect / RESYNC: the player's own cards, again. */
  rePushHoleCards(roomId: string, userId: string): void {
    this.hostByRoom.get(roomId)?.rePushHoleCards(userId);
  }
}

export interface LightningHostingDeps {
  registry: LightningRegistry;
  backend: LightningHandBackend;
  hub: LightningHub;
  leaseFor(hostTableId: string): LightningLease | null;
  metrics?: LightningMetrics;
  /** Injected for tests. */
  hostOptions?: Partial<Pick<LightningHandHostDeps, 'timer' | 'sleep' | 'now' | 'logger'>>;
}

/** The worker's side of the registry: build, register and fence hosts. */
export class LightningHosting {
  private readonly timeBanks = new Map<string, LightningTimeBankLedger>();

  constructor(private readonly deps: LightningHostingDeps) {}

  hasInstance(instanceId: string): boolean {
    return this.deps.registry.hasInstance(instanceId);
  }

  /** Deal one formed hand. Returns the host (already starting). */
  startHand(
    hand: LightningFormedHand,
    config: LightningConfig,
    wake: () => void,
    onClusterFrozen?: (clusterId: string) => void
  ): LightningHandHost {
    let ledger = this.timeBanks.get(hand.clusterId);
    if (!ledger) {
      ledger = new LightningTimeBankLedger(this.deps.backend);
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
      isConnected: (playerId, roomId) => registry.isConnected(playerId, roomId),
      onPlayerReleased: (playerId, why) => {
        if (why === 'fast' || why === 'normal') registry.releaseRoom(host, playerId);
        wake();
      },
      onDealing: (h) => registry.register(h),
      onClusterFrozen: (clusterId) => onClusterFrozen?.(clusterId),
      onFinished: (h) => {
        registry.unregister(h);
        wake();
      },
      ...this.deps.hostOptions,
    });
    // Registered by onDealing, once the participants (and so the rooms) are known.
    void host.start();
    this.pending.add(host);
    void host.whenFinished().then(() => this.pending.delete(host));
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
