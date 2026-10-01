/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LIGHTNING DEALER'S DOORS TO THE DATABASE (Lightning Phase 6, 2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every database call a LightningHandHost makes goes through this one
 * interface, so the host is testable with an in-memory backend and the
 * production backend is the only place a jsonb answer becomes a type.
 *
 * THE CONTRACT (the SQL side owns it; this file honours it and nothing more):
 *
 *   fn_lightning_instance_begin_dealing(p_instance_id, p_deal_window, p_now)
 *       -> {ok, dealing, hand_id, reason}
 *   fn_next_hand_number() -> bigint                         (the physical allocator)
 *   fn_lightning_bind_hand_number(p_instance_id, p_hand_number)
 *       -> {ok, hand_id, hand_number, host_table_id, reason}
 *   fn_lightning_instance_keepalive(p_instance_id, p_extend, p_now) -> {ok, reason}
 *   fn_lightning_instance_abandon(p_instance_id, p_reason, p_now) -> {ok, abandoned}
 *   fn_lightning_fast_fold(p_hand_id, p_player_id, p_request_id, p_fold_type)
 *       -> {ok, reason}   'fast' | 'normal' free the player now; 'fold_watch' at hand end
 *   fn_lightning_settle_hand(p_hand_id, p_request_id, p_host_table_id,
 *                            p_lease_instance, p_lease_generation, p_results,
 *                            p_rake, p_bbj, p_hand_row)
 *       -> {ok, hand_id, hand_history_id, hand_number, deltas, receipt_hash, reason}
 *   fn_ca_process_hand_post_commit_obligations(p_hand_id)   (handProjection.ts)
 *   insert_hole_cards(p_table_id, p_hand_number, p_cards)   (the physical path's)
 *
 * The participants are read from `lightning_hand_player` (seat, position,
 * blind_role, stack_before, pool_slot_id), the room each one is shown the
 * hand in from `lightning_pool_slot.pool_session_id`, and the seat identity
 * from `profiles` through the same SEATED_PROFILE_SELECT and arenaPlayerName
 * the physical roster uses. None of it is ever sent to a client except the
 * name and picture a physical seat already shows.
 */
import { supabase } from '../services/supabase/client.js';
import { SEATED_PROFILE_SELECT } from '../services/supabase/tableAvatar.js';
import { arenaPlayerName, type ArenaNameProfile } from '../services/supabase/arenaPlayerName.js';
import { loadTable } from '../services/supabase/tables.js';
import { processHandPostCommitObligations } from '../services/supabase/handProjection.js';
import { isUuid } from './LightningRpc.js';

/** One formed seat, as the formation barrier wrote it. */
export interface LightningParticipant {
  playerId: string;
  /** The pool session: the room this player is shown the hand in. Never the instance. */
  poolSessionId: string;
  seat: number;
  position: string | null;
  blindRole: string;
  stackBefore: number;
  username: string;
  avatarUrl: string;
  equippedFrame: string;
  equippedAura: string;
  /** The horse's input device only (CLAUDE.md 10.5); never serialized to a client. */
  isHorse: boolean;
}

/** The host table's rules: the same columns the physical engine deals from. */
export type LightningHostRules = Record<string, any> & {
  id: string;
  small_blind: number;
  big_blind: number;
  game_variant: string;
  max_players: number;
};

export type LightningFoldType = 'fast' | 'normal' | 'fold_watch';

export interface LightningSettleResult {
  playerId: string;
  stackAfter: number;
  contributed: number;
  won: number;
  foldType: LightningFoldType | 'none';
  showed: boolean;
}

export interface LightningSettleArgs {
  handId: string;
  requestId: string;
  hostTableId: string;
  leaseInstance: string;
  leaseGeneration: string;
  results: LightningSettleResult[];
  rake: number;
  bbj: number;
  handRow: Record<string, unknown>;
}

/** What one call answered. `transport` means the outcome is UNKNOWN. */
export type LightningCallOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; transport?: boolean; frozen?: boolean };

export interface LightningHandBackend {
  beginDealing(
    instanceId: string,
    dealWindowMs: number,
    now: Date
  ): Promise<LightningCallOutcome<{ handId: string | null }>>;
  nextHandNumber(): Promise<number>;
  bindHandNumber(
    instanceId: string,
    handNumber: number
  ): Promise<LightningCallOutcome<{ handId: string; handNumber: number; hostTableId: string }>>;
  loadParticipants(handId: string): Promise<LightningParticipant[]>;
  loadHostRules(hostTableId: string): Promise<LightningHostRules>;
  insertHoleCards(
    hostTableId: string,
    handNumber: number,
    rows: Array<{ user_id: string; seat_number: number; cards: unknown }>
  ): Promise<void>;
  keepalive(instanceId: string, extendMs: number, now: Date): Promise<LightningCallOutcome<null>>;
  abandon(instanceId: string, reason: string, now: Date): Promise<LightningCallOutcome<null>>;
  fastFold(
    handId: string,
    playerId: string,
    requestId: string,
    foldType: LightningFoldType,
    /** The chips the folder has put in this hand's pot (p_committed). */
    committed: number
  ): Promise<LightningCallOutcome<null>>;
  settle(
    args: LightningSettleArgs
  ): Promise<LightningCallOutcome<{ handHistoryId: string; receiptHash: string | null }>>;
  postCommit(handHistoryId: string): Promise<void>;
  /** fn_time_bank_allowance_v2: extra seconds beyond the base, per player. */
  timeBankAllowance(
    userIds: string[]
  ): Promise<Map<string, { extraSeconds: number; unlimitedActivations: boolean }>>;
  /** fn_consume_time_bank: the paid seconds a player spent. */
  consumeTimeBank(userId: string, seconds: number): Promise<void>;
}

const MS = (ms: number) => `${Math.max(0, Math.round(ms))} milliseconds`;

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function refusal(data: unknown): string {
  const row = obj(data);
  const reason = row?.reason ?? row?.error;
  return typeof reason === 'string' && reason ? reason : 'refused';
}

async function call(
  fn: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; error: unknown } | { thrown: unknown }> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    return { data, error };
  } catch (thrown) {
    return { thrown };
  }
}

/** ok:true answers pass; an error or a throw is a TRANSPORT failure (outcome unknown). */
async function okCall(
  fn: string,
  args: Record<string, unknown>
): Promise<LightningCallOutcome<Record<string, unknown>>> {
  const out = await call(fn, args);
  if ('thrown' in out) return { ok: false, reason: `${fn}_threw`, transport: true };
  if (out.error) return { ok: false, reason: `${fn}_failed`, transport: true };
  const row = obj(out.data);
  // A conservation disagreement FREEZES the Cluster rather than raising:
  // terminal, never retried and never abandoned (fn_lightning_settle_hand).
  if (row && row.ok !== true && row.frozen === true)
    return { ok: false, reason: refusal(out.data), frozen: true };
  if (!row || row.ok !== true) return { ok: false, reason: refusal(out.data) };
  return { ok: true, value: row };
}

/** The production backend. */
export function createSupabaseLightningHandBackend(): LightningHandBackend {
  return {
    async beginDealing(instanceId, dealWindowMs, now) {
      const out = await okCall('fn_lightning_instance_begin_dealing', {
        p_instance_id: instanceId,
        p_deal_window: MS(dealWindowMs),
        p_now: now.toISOString(),
      });
      if (!out.ok) return out;
      const handId = out.value.hand_id;
      return { ok: true, value: { handId: isUuid(handId) ? handId : null } };
    },

    async nextHandNumber() {
      const { data, error } = await supabase.rpc('fn_next_hand_number');
      if (error) throw new Error(`fn_next_hand_number failed: ${error.message}`);
      const canonical =
        typeof data === 'number' || (typeof data === 'string' && /^[1-9][0-9]*$/.test(data));
      const n = canonical ? Number(data) : NaN;
      if (!Number.isSafeInteger(n) || n < 1000000)
        throw new Error('allocator_unsafe_or_invalid_integer');
      return n;
    },

    async bindHandNumber(instanceId, handNumber) {
      const out = await okCall('fn_lightning_bind_hand_number', {
        p_instance_id: instanceId,
        p_hand_number: handNumber,
      });
      if (!out.ok) return out;
      const v = out.value;
      if (!isUuid(v.hand_id) || !isUuid(v.host_table_id) || Number(v.hand_number) !== handNumber)
        return { ok: false, reason: 'bind_answer_invalid' };
      return {
        ok: true,
        value: { handId: v.hand_id, handNumber, hostTableId: v.host_table_id },
      };
    },

    async loadParticipants(handId) {
      const { data: rows, error } = await supabase
        .from('lightning_hand_player')
        .select('player_id, pool_slot_id, seat, position, blind_role, stack_before')
        .eq('hand_id', handId);
      if (error) throw new Error(`lightning_hand_player read failed: ${error.message}`);
      const players = (rows ?? []) as Array<Record<string, any>>;
      if (players.length < 2) throw new Error('lightning hand has fewer than two participants');
      const slotIds = players.map((p) => p.pool_slot_id);
      const { data: slots, error: slotError } = await supabase
        .from('lightning_pool_slot')
        .select('id, pool_session_id, player_id')
        .in('id', slotIds);
      if (slotError) throw new Error(`lightning_pool_slot read failed: ${slotError.message}`);
      const sessionBySlot = new Map<string, string>();
      for (const s of (slots ?? []) as Array<Record<string, any>>) {
        sessionBySlot.set(s.id, s.pool_session_id);
      }
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select(SEATED_PROFILE_SELECT)
        .in(
          'id',
          players.map((p) => p.player_id)
        );
      if (profileError) throw new Error(`profiles read failed: ${profileError.message}`);
      const profileById = new Map<string, Record<string, any>>();
      for (const p of (profiles ?? []) as unknown as Array<Record<string, any>>)
        profileById.set(p.id, p);
      return players.map((p) => {
        const poolSessionId = sessionBySlot.get(p.pool_slot_id);
        if (!isUuid(poolSessionId)) throw new Error('participant has no pool session');
        const profile = profileById.get(p.player_id) ?? null;
        return {
          playerId: p.player_id,
          poolSessionId,
          seat: Number(p.seat),
          position: p.position ?? null,
          blindRole: p.blind_role ?? 'none',
          stackBefore: Number(p.stack_before),
          username: arenaPlayerName(profile as ArenaNameProfile | null),
          avatarUrl: profile?.avatar_url ?? '',
          equippedFrame: profile?.equipped_frame ?? '',
          equippedAura: profile?.equipped_aura ?? '',
          isHorse: profile?.is_horse === true,
        };
      });
    },

    async loadHostRules(hostTableId) {
      // The same rule row the physical engine deals from (loadTable), plus the
      // club rake defaults refreshRakeConfig reads beside it.
      const table = (await loadTable(hostTableId)) as unknown as LightningHostRules;
      let clubRakeDefaults: { rakePercent: number | null; rakeCapBB: number | null } | null = null;
      if (table.club_id) {
        const { data: club } = await supabase
          .from('clubs')
          .select('default_rake_percent, rake_cap')
          .eq('id', table.club_id)
          .maybeSingle();
        if (club) {
          clubRakeDefaults = {
            rakePercent: (club as any).default_rake_percent ?? null,
            rakeCapBB: (club as any).rake_cap ?? null,
          };
        }
      }
      return { ...table, club_rake_defaults: clubRakeDefaults };
    },

    async insertHoleCards(hostTableId, handNumber, rows) {
      const { error } = await supabase.rpc('insert_hole_cards', {
        p_table_id: hostTableId,
        p_hand_number: handNumber,
        p_cards: JSON.stringify(rows),
      });
      if (error) throw new Error(`insert_hole_cards failed: ${error.message}`);
    },

    async keepalive(instanceId, extendMs, now) {
      const out = await okCall('fn_lightning_instance_keepalive', {
        p_instance_id: instanceId,
        p_extend: MS(extendMs),
        p_now: now.toISOString(),
      });
      return out.ok ? { ok: true, value: null } : out;
    },

    async abandon(instanceId, reason, now) {
      const out = await okCall('fn_lightning_instance_abandon', {
        p_instance_id: instanceId,
        p_reason: reason,
        p_now: now.toISOString(),
      });
      return out.ok ? { ok: true, value: null } : out;
    },

    async fastFold(handId, playerId, requestId, foldType, committed) {
      const out = await okCall('fn_lightning_fast_fold', {
        p_hand_id: handId,
        p_player_id: playerId,
        p_request_id: requestId,
        p_fold_type: foldType,
        // Always sent: without it the folder's whole stack stays held out of
        // the next hand until this one settles.
        p_committed: Math.round(committed * 100) / 100,
      });
      return out.ok ? { ok: true, value: null } : out;
    },

    async settle(a) {
      const out = await okCall('fn_lightning_settle_hand', {
        p_hand_id: a.handId,
        p_request_id: a.requestId,
        p_host_table_id: a.hostTableId,
        p_lease_instance: a.leaseInstance,
        p_lease_generation: a.leaseGeneration,
        p_results: a.results.map((r) => ({
          player_id: r.playerId,
          stack_after: r.stackAfter,
          contributed: r.contributed,
          won: r.won,
          fold_type: r.foldType,
          showed: r.showed,
        })),
        p_rake: a.rake,
        p_bbj: a.bbj,
        p_hand_row: a.handRow,
      });
      if (!out.ok) return out;
      const id = out.value.hand_history_id;
      if (!isUuid(id)) return { ok: false, reason: 'settle_answer_invalid', transport: true };
      return {
        ok: true,
        value: {
          handHistoryId: id,
          receiptHash: typeof out.value.receipt_hash === 'string' ? out.value.receipt_hash : null,
        },
      };
    },

    async postCommit(handHistoryId) {
      await processHandPostCommitObligations(handHistoryId);
    },

    async timeBankAllowance(userIds) {
      const out = new Map<string, { extraSeconds: number; unlimitedActivations: boolean }>();
      if (userIds.length === 0) return out;
      const { data, error } = await supabase.rpc('fn_time_bank_allowance_v2', {
        p_user_ids: userIds,
      });
      if (error) throw new Error(`fn_time_bank_allowance_v2 failed: ${error.message}`);
      for (const row of (data as Array<Record<string, any>>) ?? []) {
        out.set(row.user_id, {
          extraSeconds: Math.max(0, Number(row.extra_seconds) || 0),
          unlimitedActivations: row.is_lifetime === true && row.unlimited_activations === true,
        });
      }
      return out;
    },

    async consumeTimeBank(userId, seconds) {
      const { data, error } = await supabase.rpc('fn_consume_time_bank', {
        p_user_id: userId,
        p_seconds: seconds,
      });
      if (error || (data as { success?: boolean } | null)?.success !== true) {
        throw new Error(`fn_consume_time_bank unconfirmed: ${error?.message ?? 'missing receipt'}`);
      }
    },
  };
}
