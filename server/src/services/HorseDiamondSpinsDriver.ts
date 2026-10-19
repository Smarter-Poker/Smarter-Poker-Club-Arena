/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE DIAMOND SPINS - the driver (Dan, 2026-10-18)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "A HORSE WITH NO CHIPS LEFT GRINDS THE DIAMOND ARENA AND USES ITS DIAMONDS
 * ON DIAMOND SPINS TO CONVERT TO CHIPS."
 *
 * The horse's hand on the wheel. A horse has no browser, so the engine does
 * what the Diamond Spins page does for a person (CLAUDE.md 10.5, the input
 * device): commit a seed, spin, play the bonus game it lands, turn the card it
 * is dealt, and spin again until it can be seated. Every one of those goes
 * through ONE door, `fn_horse_diamond_spins` (migration 20261019023857),
 * which opens only for the engine, only for a horse, and runs the exact public
 * function the page calls. There is no second wheel and no second rule here.
 *
 * What this file decides is only what a player decides, and it takes those
 * decisions from HorseDiamondSpins (pure, hashed, replayable). It never reads
 * a sealed outcome: the crash point, mine cells, road roll, server seeds and
 * card order are never selected (pinned by
 * aHorseSpinsThroughTheEngineDoor.law.test.ts).
 *
 * STATELESS ACROSS RESTARTS. The engine restarts every hour. Who is spinning
 * is read from the database each pass: a horse out of chips at a club, or one
 * that spun there inside the session window and is still under its target, or
 * one with a card or bonus game still unplayed. The only memory is pacing.
 *
 * THE FREEZE. Nothing moves during the hourly break (CLAUDE.md 13): the pass
 * checks it first and between actions, and the wheel refuses anyway.
 */

import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { selectInChunks } from './supabase/chunkedIn.js';
import { fetchAllRows } from './supabase/pagination.js';
import { MIDWAY_UNION_ID, WALLETS_FOR_HOST } from './StableHand.js';
import {
  CHOICE_MODE,
  cheapestGame,
  crashCashoutCents,
  isOutOfChips,
  maxSpinTargetChips,
  nextStep,
  paceMs,
  plinkoDropValue,
  spinTargetChips,
  backoffForRefusal,
  type BonusGame,
  type CheapestGame,
  type HorseSpinState,
  type HorseSpinStep,
  type OpenChoiceRound,
  type OpenCrashRound,
  type PendingAward,
  type PendingCard,
} from './HorseDiamondSpins.js';

export const HORSE_DIAMOND_SPINS_TICK_MS = Number(process.env.HORSE_DIAMOND_SPINS_TICK_MS ?? 5_000);
/** How long after its last spin a horse still counts as mid-session. */
export const SESSION_WINDOW_MS = 2 * 60 * 60_000;
/** Actions per pass across the whole fleet, so the wheel sees a room of
 *  players, not a burst. */
export const ACTIONS_PER_PASS = 6;
/** Re-read the floor and the memberships this often; act in between. */
export const ROSTER_REFRESH_MS = 30_000;
const MEMBER_STATUSES = ['active', 'approved'];

export interface SpinMember {
  userId: string;
  clubId: string;
  chips: number;
  diamonds: number;
}

export interface OpenWork {
  cards: Array<PendingCard & { userId: string }>;
  awards: Array<PendingAward & { userId: string }>;
  crashRounds: Array<OpenCrashRound & { userId: string }>;
  choiceRounds: Array<OpenChoiceRound & { userId: string }>;
}

export interface HorseSpinDoors {
  frozen(): boolean;
  /** The host's open cash games (big blind, min and max buy-in). */
  loadOpenGames(): Promise<Array<{
    big_blind: unknown;
    min_buy_in: unknown;
    max_buy_in: unknown;
  }> | null>;
  /** Horse memberships at the host's wallets below `maxChips`, with Diamonds.
   *  Null when the read was incomplete (fail closed: no pass). */
  loadMembers(maxChips: number): Promise<SpinMember[] | null>;
  /** One horse's membership as it stands now: 'gone' when it is no longer an
   *  active membership of a horse, null when the read failed. */
  loadMember(userId: string, clubId: string): Promise<SpinMember | 'gone' | null>;
  /** `${userId}:${clubId}` for every spin at or after `sinceIso`. */
  loadRecentSpins(userIds: string[], sinceIso: string): Promise<Set<string> | null>;
  loadOpenWork(userIds: string[]): Promise<OpenWork | null>;
  /** The one door. */
  act(horseId: string, action: string, args: Record<string, unknown>): Promise<unknown>;
  now(): number;
  seed(): string;
}

/* ------------------------------------------------------------------ */
/* The live doors                                                       */
/* ------------------------------------------------------------------ */

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const rpcDoors: HorseSpinDoors = {
  frozen: () => isMaintenanceFrozen(),
  async loadOpenGames() {
    const { data, error } = await supabase
      .from('tables')
      .select('big_blind, min_buy_in, max_buy_in')
      .eq('union_id', MIDWAY_UNION_ID)
      .is('tournament_id', null)
      .eq('game_type', 'cash')
      .in('status', ['waiting', 'running']);
    if (error || !data) return null;
    return data;
  },
  async loadMembers(maxChips) {
    const rows: Array<{ user_id: string; club_id: string; chip_balance: unknown }> = [];
    for (const clubId of WALLETS_FOR_HOST[MIDWAY_UNION_ID] ?? []) {
      const page = await fetchAllRows<{ user_id: string; club_id: string; chip_balance: unknown }>(
        (cursor, want) => {
          let q = supabase
            .from('club_members')
            .select('user_id, club_id, chip_balance')
            .eq('club_id', clubId)
            .in('status', MEMBER_STATUSES)
            .lt('chip_balance', maxChips)
            .order('user_id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('user_id', cursor);
          return q;
        },
        { label: 'HorseDiamondSpins.members', idKey: 'user_id', maxRows: 50_000 }
      );
      if (!page.complete) return null;
      rows.push(...page.rows);
    }
    if (rows.length === 0) return [];
    // Who is a horse, and its Diamonds, asked of profiles directly - never
    // through a club_members embed (StableHandSnapshot: it is ambiguous).
    const horses = await selectInChunks<{ id: string; diamonds: unknown }>(
      rows.map((r) => r.user_id),
      (batch) =>
        supabase.from('profiles').select('id, diamonds').eq('is_horse', true).in('id', batch),
      'HorseDiamondSpins.horses'
    );
    if (!horses.complete) return null;
    const diamonds = new Map(horses.rows.map((h) => [String(h.id), num(h.diamonds)]));
    return rows
      .filter((r) => diamonds.has(String(r.user_id)))
      .map((r) => ({
        userId: String(r.user_id),
        clubId: String(r.club_id),
        chips: num(r.chip_balance),
        diamonds: diamonds.get(String(r.user_id)) ?? 0,
      }));
  },
  async loadMember(userId, clubId) {
    const [m, p] = await Promise.all([
      supabase
        .from('club_members')
        .select('chip_balance')
        .eq('club_id', clubId)
        .eq('user_id', userId)
        .in('status', MEMBER_STATUSES)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('diamonds')
        .eq('id', userId)
        .eq('is_horse', true)
        .maybeSingle(),
    ]);
    if (m.error || p.error) return null;
    if (!m.data || !p.data) return 'gone';
    return { userId, clubId, chips: num(m.data.chip_balance), diamonds: num(p.data.diamonds) };
  },
  async loadRecentSpins(userIds, sinceIso) {
    const res = await selectInChunks<{ user_id: string; club_id: string }>(
      userIds,
      (batch) =>
        supabase
          .from('wheel_spins')
          .select('user_id, club_id')
          .in('user_id', batch)
          .gte('created_at', sinceIso),
      'HorseDiamondSpins.recentSpins'
    );
    if (!res.complete) return null;
    return new Set(res.rows.map((r) => `${r.user_id}:${r.club_id}`));
  },
  async loadOpenWork(userIds) {
    // Only what a player can see on their own screen. Never the crash point,
    // the mine cells, the road roll, a seed or the card order.
    const [cards, awards, crash, choice] = await Promise.all([
      selectInChunks<{ id: string; user_id: string; club_id: string }>(
        userIds,
        (batch) =>
          supabase
            .from('wheel_card_awards')
            .select('id, user_id, club_id')
            .eq('status', 'pending')
            .in('user_id', batch),
        'HorseDiamondSpins.cards'
      ),
      selectInChunks<{
        id: string;
        user_id: string;
        club_id: string;
        game: string;
        base_diamonds: unknown;
        created_at: string;
      }>(
        userIds,
        (batch) =>
          supabase
            .from('wheel_bonus_awards')
            .select('id, user_id, club_id, game, base_diamonds, created_at')
            .eq('status', 'pending')
            .in('user_id', batch),
        'HorseDiamondSpins.awards'
      ),
      selectInChunks<{ id: string; user_id: string; club_id: string }>(
        userIds,
        (batch) =>
          supabase
            .from('crash_rounds')
            .select('id, user_id, club_id')
            .eq('status', 'open')
            .in('user_id', batch),
        'HorseDiamondSpins.crashRounds'
      ),
      selectInChunks<{
        id: string;
        user_id: string;
        club_id: string;
        game: string;
        picked: number[] | null;
        max_steps: unknown;
      }>(
        userIds,
        (batch) =>
          supabase
            .from('diamond_choice_rounds')
            .select('id, user_id, club_id, game, picked, max_steps')
            .eq('status', 'open')
            .in('user_id', batch),
        'HorseDiamondSpins.choiceRounds'
      ),
    ]);
    if (!cards.complete || !awards.complete || !crash.complete || !choice.complete) return null;
    return {
      cards: cards.rows.map((r) => ({ id: r.id, userId: r.user_id, clubId: r.club_id })),
      awards: awards.rows
        .filter((r) => ['plinko', 'crash', 'mines', 'crossing'].includes(r.game))
        .map((r) => ({
          id: r.id,
          userId: r.user_id,
          clubId: r.club_id,
          game: r.game as BonusGame,
          baseDiamonds: num(r.base_diamonds),
          createdAt: String(r.created_at),
        })),
      crashRounds: crash.rows.map((r) => ({ id: r.id, userId: r.user_id, clubId: r.club_id })),
      choiceRounds: choice.rows
        .filter((r) => r.game === 'mines' || r.game === 'crossing')
        .map((r) => ({
          id: r.id,
          userId: r.user_id,
          clubId: r.club_id,
          game: r.game as 'mines' | 'crossing',
          picked: Array.isArray(r.picked) ? r.picked.map(Number) : [],
          maxSteps: Math.max(1, num(r.max_steps)),
        })),
    };
  },
  async act(horseId, action, args) {
    const { data, error } = await supabase.rpc('fn_horse_diamond_spins', {
      p_horse_id: horseId,
      p_action: action,
      p_args: args,
    });
    if (error) throw new Error(`fn_horse_diamond_spins ${action}: ${error.message}`);
    return data;
  },
  now: () => Date.now(),
  seed: () => crypto.randomUUID(),
};

let doors: HorseSpinDoors = rpcDoors;

/** Tests swap the doors; null restores the live ones. */
export function __setHorseSpinDoors(next: HorseSpinDoors | null): void {
  doors = next ?? rpcDoors;
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

export interface HorseSpinStatus {
  active: boolean;
  lastPassAt: string | null;
  lastRosterAt: string | null;
  inSession: number;
  spins: number;
  bonusesStarted: number;
  moves: number;
  cardsPicked: number;
  refusals: Record<string, number>;
  errors: number;
}

const status: HorseSpinStatus = {
  active: false,
  lastPassAt: null,
  lastRosterAt: null,
  inSession: 0,
  spins: 0,
  bonusesStarted: 0,
  moves: 0,
  cardsPicked: 0,
  refusals: {},
  errors: 0,
};

export function horseDiamondSpinsStatus(): HorseSpinStatus {
  return { ...status, refusals: { ...status.refusals } };
}

interface Roster {
  at: number;
  game: CheapestGame;
  states: HorseSpinState[];
}

let roster: Roster | null = null;
const nextActionAt = new Map<string, number>();
let paceNonce = 0;

/** Clear memory between tests. */
export function __resetHorseSpins(): void {
  roster = null;
  nextActionAt.clear();
  paceNonce = 0;
  for (const k of Object.keys(status.refusals)) delete status.refusals[k];
  Object.assign(status, {
    lastPassAt: null,
    lastRosterAt: null,
    inSession: 0,
    spins: 0,
    bonusesStarted: 0,
    moves: 0,
    cardsPicked: 0,
    errors: 0,
  });
}

/** Build every (horse, club) that has something to do this window. */
export async function readRoster(): Promise<Roster | null> {
  const games = await doors.loadOpenGames();
  if (!games) return null;
  const game = cheapestGame(games);
  if (!game) return null;
  const members = await doors.loadMembers(maxSpinTargetChips(game));
  if (!members) return null;
  if (members.length === 0) return { at: doors.now(), game, states: [] };
  const ids = [...new Set(members.map((m) => m.userId))];
  const since = new Date(doors.now() - SESSION_WINDOW_MS).toISOString();
  const [recent, work] = await Promise.all([
    doors.loadRecentSpins(ids, since),
    doors.loadOpenWork(ids),
  ]);
  if (!recent || !work) return null;

  const states: HorseSpinState[] = [];
  for (const m of members) {
    const targetChips = spinTargetChips(m.userId, game);
    const own = <T extends { userId: string }>(xs: T[]) => xs.filter((x) => x.userId === m.userId);
    const state: HorseSpinState = {
      horseId: m.userId,
      clubId: m.clubId,
      chips: m.chips,
      diamonds: m.diamonds,
      targetChips,
      inSession:
        isOutOfChips(m.chips, game) ||
        (m.chips < targetChips && recent.has(`${m.userId}:${m.clubId}`)),
      cards: own(work.cards),
      awards: own(work.awards),
      crashRounds: own(work.crashRounds),
      choiceRounds: own(work.choiceRounds),
    };
    if (nextStep(state).kind !== 'rest') states.push(state);
  }
  return { at: doors.now(), game, states };
}

function countRefusal(error: string): void {
  status.refusals[error] = (status.refusals[error] ?? 0) + 1;
}

function refusalOf(result: unknown): string | null {
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    const e = (result as { error?: unknown }).error;
    return typeof e === 'string' && e ? e : 'refused';
  }
  return null;
}

/** Carry out one step for one horse. Returns the pause before its next one. */
export async function runStep(state: HorseSpinState, step: HorseSpinStep): Promise<number> {
  const h = state.horseId;
  let result: unknown;
  switch (step.kind) {
    case 'pick_card':
      result = await doors.act(h, 'cards_pick', { award_id: step.awardId, card: step.card });
      if (!refusalOf(result)) status.cardsPicked += 1;
      break;
    case 'crash_settle':
      result = await doors.act(h, 'crash_settle', { round_id: step.roundId, cashout: false });
      break;
    case 'choice_move':
      result = await doors.act(h, 'choice_act', {
        round_id: step.roundId,
        action: step.action,
        cell: step.cell,
        expected_step: step.expectedStep,
      });
      if (!refusalOf(result)) status.moves += 1;
      break;
    case 'start_bonus': {
      const a = step.award;
      const commit = await doors.act(h, 'game_commit', { game: a.game });
      const commitRefusal = refusalOf(commit);
      const commitId = (commit as { commit_id?: unknown } | null)?.commit_id;
      if (commitRefusal || typeof commitId !== 'string') {
        result = { ok: false, error: commitRefusal ?? 'No Seed Ticket' };
        break;
      }
      const args: Record<string, unknown> = {
        award_id: a.id,
        commit_id: commitId,
        client_seed: doors.seed(),
        double: false,
      };
      if (a.game === 'plinko') args.denom = plinkoDropValue(a.baseDiamonds);
      if (a.game === 'crash') args.auto_cashout_cents = crashCashoutCents(h, a.id);
      if (a.game === 'mines' || a.game === 'crossing') {
        args.mode = CHOICE_MODE[a.game];
        const st = await doors.act(h, 'choice_state', {
          club_id: a.clubId,
          game: a.game,
          mode: CHOICE_MODE[a.game],
          bet: a.baseDiamonds,
        });
        const max = Number((st as { max_steps?: unknown } | null)?.max_steps);
        if (!(max >= 1)) {
          result = { ok: false, error: refusalOf(st) ?? 'The Round Limit Could Not Be Read' };
          break;
        }
        args.max_steps = max;
      }
      result = await doors.act(h, 'bonus_start', args);
      if (!refusalOf(result)) status.bonusesStarted += 1;
      break;
    }
    case 'spin': {
      const commit = await doors.act(h, 'wheel_commit', {});
      const commitRefusal = refusalOf(commit);
      const commitId = (commit as { commit_id?: unknown } | null)?.commit_id;
      if (commitRefusal || typeof commitId !== 'string') {
        result = { ok: false, error: commitRefusal ?? 'No Seed Ticket' };
        break;
      }
      result = await doors.act(h, 'wheel_spin', {
        club_id: state.clubId,
        commit_id: commitId,
        client_seed: doors.seed(),
        entry_diamonds: step.entry,
        mode: 'paid',
      });
      if (!refusalOf(result)) status.spins += 1;
      break;
    }
    default:
      return paceMs(h, 'rest', ++paceNonce);
  }

  const refusal = refusalOf(result);
  if (refusal) {
    countRefusal(refusal);
    const wait = backoffForRefusal(refusal);
    if (wait === null) {
      // A refusal nobody planned for is a defect to look at, not a retry loop.
      reportError(
        new Error(`[HorseDiamondSpins] ${step.kind} refused for ${h}: ${refusal}`),
        'HorseDiamondSpins.unexpected_refusal'
      );
      return 15 * 60_000;
    }
    return wait;
  }
  return paceMs(h, step.kind, ++paceNonce);
}

/**
 * One pass: refresh the roster when it is stale, then take at most
 * ACTIONS_PER_PASS horses whose pause is over and do the next thing for each.
 * Each state is re-read before it acts (the roster is a list of who, never
 * of what): a horse acts on its own rows as they stand now.
 */
export async function horseSpinPass(isCurrent: () => boolean = () => true): Promise<void> {
  status.lastPassAt = new Date(doors.now()).toISOString();
  if (doors.frozen()) return;
  if (!roster || doors.now() - roster.at >= ROSTER_REFRESH_MS) {
    const next = await readRoster();
    if (!next) return; // fail closed: an unread room is not acted on
    roster = next;
    status.lastRosterAt = new Date(roster.at).toISOString();
    status.inSession = roster.states.length;
  }
  const now = doors.now();
  const due = roster.states
    .filter((s) => (nextActionAt.get(s.horseId) ?? 0) <= now)
    .slice(0, ACTIONS_PER_PASS);
  const acted = new Set<string>();
  for (const listed of due) {
    if (!isCurrent() || doors.frozen()) return;
    if (acted.has(listed.horseId)) continue; // one action per horse per pass
    acted.add(listed.horseId);
    let wait: number;
    try {
      const fresh = await refreshState(listed);
      const step = fresh ? nextStep(fresh) : ({ kind: 'rest' } as const);
      wait = fresh ? await runStep(fresh, step) : paceMs(listed.horseId, 'rest', ++paceNonce);
    } catch (err) {
      status.errors += 1;
      reportError(err, 'HorseDiamondSpins.step');
      wait = 5 * 60_000;
    }
    nextActionAt.set(listed.horseId, doors.now() + wait);
  }
}

/** The horse's own rows as they stand now. */
async function refreshState(listed: HorseSpinState): Promise<HorseSpinState | null> {
  const [m, work] = await Promise.all([
    doors.loadMember(listed.horseId, listed.clubId),
    doors.loadOpenWork([listed.horseId]),
  ]);
  if (!m || m === 'gone' || !work) return null;
  return {
    ...listed,
    chips: m.chips,
    diamonds: m.diamonds,
    cards: work.cards,
    awards: work.awards,
    crashRounds: work.crashRounds,
    choiceRounds: work.choiceRounds,
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlight = new Set<Promise<void>>();

const lifecycleIsCurrent = (generation: number): boolean =>
  lifecycleActive && lifecycleGeneration === generation;

function launchPass(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlight.size > 0) return;
  const tracked: Promise<void> = horseSpinPass(() => lifecycleIsCurrent(generation))
    .catch((err) => {
      status.errors += 1;
      reportError(err, 'HorseDiamondSpins.pass');
    })
    .finally(() => inFlight.delete(tracked));
  inFlight.add(tracked);
}

export function horseDiamondSpinsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.HORSE_DIAMOND_SPINS ?? 'true').toLowerCase() !== 'false';
}

export function startHorseDiamondSpins(): void {
  if (lifecycleActive || !horseDiamondSpinsEnabled()) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  status.active = true;
  timer = setInterval(launchPass, HORSE_DIAMOND_SPINS_TICK_MS);
  timer.unref?.();
  console.log(
    `[HorseDiamondSpins] Running - horses out of chips spin Diamonds every ${HORSE_DIAMOND_SPINS_TICK_MS / 1000}s pass`
  );
}

export function stopHorseDiamondSpins(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  status.active = false;
  if (timer) clearInterval(timer);
  timer = null;
  stopOperation = (async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  })();
  return stopOperation;
}
