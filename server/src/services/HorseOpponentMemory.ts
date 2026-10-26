import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { noteFire } from '../engine/BrainTelemetry.js';
import {
  memoryVariant,
  opponentMemoryDonors,
  OPPONENT_MEMORY_THIN_HANDS,
  validOpponentDonorProfiles,
  opponentProfileVersion,
  validOpponentProfile,
  type DurableOpponentProfile,
  type MemoryMode,
  type MemorySize,
} from '../engine/HorseOpponentMemory.js';

export type OpponentMemorySchema = 'installed' | 'unavailable' | 'unknown';
/** Installed schema is cached. Failed probes recover on an original request
 * after a bounded cooldown; no timer or background database repair is involved. */
export function createOpponentMemorySchemaProbe(now = Date.now) {
  let state: Promise<OpponentMemorySchema> | null = null;
  let retryAt = Infinity;
  return (): Promise<OpponentMemorySchema> => {
    if (state && now() >= retryAt) {
      state = null;
      retryAt = Infinity;
    }
    return (state ??= (async () => {
      try {
        const { data, error } = await supabase
          .from('horse_exploit_profiles')
          .select('user_id,variant,mode,size,counters,observed_hands,initialized')
          .limit(0)
          .abortSignal(AbortSignal.timeout(5000));
        if (!error && Array.isArray(data)) return 'installed';
        reportError(
          new Error(`opponent schema unavailable: ${error?.code ?? 'invalid_receipt'}`),
          'HorseOpponentMemory.schema'
        );
        return ['42P01', 'PGRST205'].includes(error?.code ?? '') ? 'unavailable' : 'unknown';
      } catch (error) {
        reportError(error, 'HorseOpponentMemory.schema');
        return 'unknown';
      }
    })().then((result) => {
      retryAt = result === 'installed' ? Infinity : now() + 60_000;
      return result;
    }));
  };
}
export const horseOpponentMemorySchema = createOpponentMemorySchemaProbe();

/** Process-wide admission, shared by decision and completed-hand readers. No
 * queued work survives a turn or launches later without an original request. */
export function createOpponentMemoryReadAdmission(now = () => Date.now()) {
  let active = 0;
  let retryAt = 0;
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active >= 8 || now() < retryAt) throw new Error('opponent memory unavailable: busy');
    active++;
    try {
      return await read();
    } catch (error) {
      // A canceled HTTP request is not proof that PostgreSQL stopped. Keep new
      // requests out for one HTTP request budget; the DB also owns its lock.
      retryAt = now() + 1500;
      throw error;
    } finally {
      active--;
    }
  };
}
const admitOpponentMemoryRead = createOpponentMemoryReadAdmission();
/**
 * Donor reads (the sibling table size's saved row) are admitted on their own.
 * Measured 2026-10-25 over six production hours: 36,244 donor reads were
 * turned away as busy and 156 reached the database, because one slow or
 * canceled exact read closes the shared gate for 1.5 seconds. The donor read
 * is a plain indexed select of saved rows (pg_stat_statements: 0.1 ms mean),
 * never the cold initializer, so its own gate keeps the same bound without
 * inheriting the exact read's lockout.
 */
const admitOpponentDonorRead = createOpponentMemoryReadAdmission();

/** Bounded last-validated snapshots survive transient load, never cross a
 * game context, and never let an older in-flight receipt regress knowledge. */
export function createOpponentMemoryProfileCache() {
  const profiles = new Map<string, DurableOpponentProfile>();
  const key = (id: string, variant: string, mode: MemoryMode, size: MemorySize) =>
    JSON.stringify([variant, mode, size, id]);
  return {
    remember(rows: DurableOpponentProfile[]) {
      for (const row of rows) {
        if (!validOpponentProfile(row)) continue;
        const k = key(row.user_id, row.variant, row.mode, row.size);
        const previous = profiles.get(k);
        if (previous && opponentProfileVersion(previous) > opponentProfileVersion(row)) continue;
        profiles.delete(k);
        profiles.set(k, structuredClone(row));
      }
      while (profiles.size > 20_000) profiles.delete(profiles.keys().next().value!);
    },
    read(ids: string[], variant: string, mode: MemoryMode, size: MemorySize) {
      return ids.flatMap((id) => {
        const row = profiles.get(key(id, variant, mode, size));
        return row ? [structuredClone(row)] : [];
      });
    },
  };
}
const validatedOpponentProfiles = createOpponentMemoryProfileCache();

/**
 * READ COST IS A NUMBER (2026-10-24). Every Lightning hand now adds one
 * post-commit profile read beside the per-hand decision read, and on
 * 2026-10-24 the expensive cold read had to be contained for database CPU.
 * Each read files its outcome and a latency bucket into the horse telemetry
 * (horse_brain_telemetry, flushed by BrainTelemetryFlush), so the load this
 * read puts on the database is read from rows, not assumed:
 *   horse_opponent_memory_read_{ok|busy|timeout|failed|incomplete}
 *   horse_opponent_memory_read_ms_{le50|le100|le250|le500|le1000|gt1000}
 *   horse_opponent_memory_read_cache_fallback  (answered from known profiles)
 */
export function opponentMemoryLatencyBucket(ms: number): string {
  if (!(ms >= 0)) return 'horse_opponent_memory_read_ms_unknown';
  for (const edge of [50, 100, 250, 500, 1000])
    if (ms <= edge) return `horse_opponent_memory_read_ms_le${edge}`;
  return 'horse_opponent_memory_read_ms_gt1000';
}
export function opponentMemoryFailureFeature(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(message))
    return 'horse_opponent_memory_read_timeout';
  if (message.includes('57014')) return 'horse_opponent_memory_read_timeout';
  if (message.includes('busy')) return 'horse_opponent_memory_read_busy';
  if (message.includes('incomplete')) return 'horse_opponent_memory_read_incomplete';
  return 'horse_opponent_memory_read_failed';
}

/** One bounded read in the original hand/decision path. The database owns
 * persistence and duplicate protection; there is no flush timer or repair job. */
export async function readHorseOpponentProfiles(
  userIds: string[],
  variant: string,
  mode: MemoryMode,
  size: MemorySize,
  signal?: AbortSignal
): Promise<DurableOpponentProfile[]> {
  const v = memoryVariant(variant);
  if (!v) return [];
  const ids = [...new Set(userIds)].sort();
  if (ids.length < 1 || ids.length > 10) throw new Error('invalid opponent memory roster');
  signal?.throwIfAborted();
  const startedAt = Date.now();
  return admitOpponentMemoryRead(async () => {
    const { data, error } = await supabase
      .rpc('fn_horse_exploit_profiles_read', {
        p_user_ids: ids,
        p_variant: v,
        p_mode: mode,
        p_size: size,
      })
      .abortSignal(
        signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500)
      );
    if (error) throw new Error(`opponent memory unavailable: ${error.code ?? 'query'}`);
    if (
      !Array.isArray(data) ||
      data.length > ids.length ||
      data.some(
        (p) =>
          !validOpponentProfile(p) ||
          p.variant !== v ||
          p.mode !== mode ||
          p.size !== size ||
          !ids.includes(p.user_id)
      ) ||
      new Set(data.map((p) => p.user_id)).size !== data.length
    )
      throw new Error('opponent memory receipt incomplete');
    // Every validated row is evidence, back-filled or not (engine
    // HorseOpponentMemory.opponentProfileVersion); the newest version wins.
    validatedOpponentProfiles.remember(data as DurableOpponentProfile[]);
    noteFire('horse_opponent_memory_read_ok');
    noteFire(opponentMemoryLatencyBucket(Date.now() - startedAt));
    return validatedOpponentProfiles.read(ids, v, mode, size);
  }).catch((error) => {
    noteFire(opponentMemoryFailureFeature(error));
    const known = validatedOpponentProfiles.read(ids, v, mode, size);
    if (!known.length) throw error;
    noteFire('horse_opponent_memory_read_cache_fallback');
    reportError(error, 'HorseOpponentMemory.decisionRead');
    return known;
  });
}

/** Stop waiting at the caller deadline, including a shared schema/hand read.
 * The underlying HTTP request also receives its abort signal when owned here. */
function awaitOpponentMemory<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fetch once per table hand, before enqueueing compute. Database latency on
 * one table must never block the process-wide decision FIFO. Each new client
 * (including a restarted worker) owns a fresh bounded cache. */
export function createDecisionOpponentProfileReader(schema = horseOpponentMemorySchema) {
  const pending = new Map<string, Promise<DurableOpponentProfile[]>>();
  return async (
    request: import('../engine/horseDecision/protocol.js').LiveHorseDecisionSnapshot,
    signal?: AbortSignal
  ): Promise<DurableOpponentProfile[] | undefined> => {
    signal?.throwIfAborted();
    if ((await awaitOpponentMemory(schema(), signal)) !== 'installed') return undefined;
    signal?.throwIfAborted();
    const gs = request.gameState,
      variant = memoryVariant(gs.gameVariant);
    if (!variant) return [];
    const count = gs.dealtSeatIds?.length ?? gs.players.length;
    const size: MemorySize = count <= 2 ? 'hu' : count <= 5 ? 'short' : 'full';
    const mode = gs.gameMode === 'tournament' || gs.tournament ? 'tournament' : 'cash';
    const ids = gs.players.map((p) => p.user_id).sort();
    // ServerTableEngineTurns constructs fence as table:hand:seat:lease:turn.
    const key = JSON.stringify([request.fence.split(':').slice(0, 2), variant, mode, size, ids]);
    const existing = pending.get(key);
    const latestKnown = (profiles: DurableOpponentProfile[]) => {
      const merged = new Map(profiles.map((profile) => [profile.user_id, profile]));
      for (const profile of validatedOpponentProfiles.read(ids, variant, mode, size)) {
        const previous = merged.get(profile.user_id);
        if (!previous || opponentProfileVersion(profile) >= opponentProfileVersion(previous))
          merged.set(profile.user_id, profile);
      }
      return ids.flatMap((id) => {
        const profile = merged.get(id);
        return profile ? [profile] : [];
      });
    };
    if (existing) return awaitOpponentMemory(existing, signal).then(latestKnown);
    const read = readHorseOpponentProfiles(ids, variant, mode, size, signal).catch((error) => {
      // A failed hand is retained too: later streets must not repeatedly
      // launch the same cold initializer. A new hand may try after admission.
      reportError(error, 'HorseOpponentMemory.decisionRead');
      return validatedOpponentProfiles.read(ids, variant, mode, size);
    });
    pending.set(key, read);
    while (pending.size > 2000) pending.delete(pending.keys().next().value!);
    return awaitOpponentMemory(read, signal).then(latestKnown);
  };
}

/** Exact and donor receipts keep their independent ten-player validation caps. */
export interface DecisionOpponentProfilePacket {
  profiles: DurableOpponentProfile[];
  donorProfiles: DurableOpponentProfile[];
}

/** Load only already saved donor evidence, never initialize another history. */
export async function readExistingHorseOpponentDonors(
  ids: string[],
  variant: string,
  mode: MemoryMode,
  size: MemorySize,
  signal?: AbortSignal
): Promise<DurableOpponentProfile[]> {
  const donorSize = opponentMemoryDonors(mode, size)[0]?.[1];
  if (!donorSize || !memoryVariant(variant)) return [];
  if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
    throw new Error('invalid opponent memory donor roster');
  signal?.throwIfAborted();
  return admitOpponentDonorRead(async () => {
    const { data, error } = await supabase
      .from('horse_exploit_profiles')
      .select('user_id,variant,mode,size,counters,observed_hands,initialized')
      .in('user_id', ids)
      .eq('variant', variant)
      .eq('mode', mode)
      .eq('size', donorSize)
      .limit(10)
      .abortSignal(
        signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500)
      );
    if (error) throw new Error(`opponent memory donor unavailable: ${error.code ?? 'query'}`);
    if (!validOpponentDonorProfiles(data, ids, variant, mode, size))
      throw new Error('opponent memory donor receipt incomplete');
    validatedOpponentProfiles.remember(data);
    noteFire('horse_opponent_memory_donor_read_ok');
    return validatedOpponentProfiles.read(ids, variant, mode, donorSize);
  }).catch((error) => {
    noteFire('horse_opponent_memory_donor_read_failed');
    reportError(error, 'HorseOpponentMemory.donorRead');
    return validatedOpponentProfiles.read(ids, variant, mode, donorSize);
  });
}

/** Production first-decision reader. Donors are coalesced within the original
 * hand request; there is no timer, cold donor initializer or shared FIFO IO. */
export function createDecisionOpponentProfilePacketReader(schema = horseOpponentMemorySchema) {
  const exact = createDecisionOpponentProfileReader(schema);
  const pending = new Map<string, Promise<DurableOpponentProfile[]>>();
  return async (
    request: import('../engine/horseDecision/protocol.js').LiveHorseDecisionSnapshot,
    signal?: AbortSignal
  ): Promise<DecisionOpponentProfilePacket | undefined> => {
    const profiles = await exact(request, signal);
    signal?.throwIfAborted();
    if (profiles === undefined) return undefined;
    const gs = request.gameState,
      variant = memoryVariant(gs.gameVariant);
    const count = gs.dealtSeatIds?.length ?? gs.players.length;
    const size: MemorySize = count <= 2 ? 'hu' : count <= 5 ? 'short' : 'full';
    const mode = gs.gameMode === 'tournament' || gs.tournament ? 'tournament' : 'cash';
    const ids = gs.players.map((p) => p.user_id).sort();
    if (!variant || size === 'hu') return { profiles, donorProfiles: [] };
    const thinIds = ids.filter(
      (id) =>
        !profiles.some(
          (profile) =>
            profile.user_id === id && profile.counters.hands >= OPPONENT_MEMORY_THIN_HANDS
        )
    );
    if (!thinIds.length) return { profiles, donorProfiles: [] };
    const key = JSON.stringify([request.fence.split(':').slice(0, 2), variant, mode, size, ids]);
    let donors = pending.get(key);
    if (!donors) {
      donors = readExistingHorseOpponentDonors(thinIds, variant, mode, size, signal);
      pending.set(key, donors);
      while (pending.size > 2000) pending.delete(pending.keys().next().value!);
    }
    await awaitOpponentMemory(donors, signal);
    signal?.throwIfAborted();
    const donorSize = opponentMemoryDonors(mode, size)[0]![1];
    // Another accepted hand can refresh the validated cache without repeating
    // this hand's donor query. Never return an older in-flight receipt.
    return {
      profiles,
      donorProfiles: validatedOpponentProfiles.read(thinIds, variant, mode, donorSize),
    };
  };
}
