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
 * is read from the database each pass: a horse the fleet can no longer seat at
 * the cheapest open game (its wallet plus the chips it has on a cash table at
 * that club are under the seat bar), or one with a card or bonus game still
 * unplayed. The only memory is pacing.
 *
 * THE READER. `horseDiamondSpinsStatus()` is published on the engine's
 * /health as `horseDiamondSpins`: how many horses the fleet cannot seat, how
 * many of those have no Diamonds above the reserve to spin with, and every
 * spin, bonus game, refusal and error since the engine started.
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
  DIAMOND_RESERVE,
  SPIN_ENTRIES,
  cheapestGame,
  crashCashoutCents,
  cannotBeSeated,
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
/** Actions per pass across the whole fleet, so the wheel sees a room of
 *  players, not a burst. */
export const ACTIONS_PER_PASS = 6;
/** Re-read the floor and the memberships this often; act in between. */
export const ROSTER_REFRESH_MS = 30_000;
const MEMBER_STATUSES = ['active', 'approved'];

export interface SpinMember {
  userId: string;
  clubId: string;
  /** The club wallet (`club_members.chip_balance`). */
  chips: number;
  /** Chips this horse has on cash tables paid from that wallet. They are
   *  still its roll: they come back to the wallet when it stands up. */
  feltChips: number;
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
  /** Horse memberships at the host's wallets whose wallet is below
   *  `maxChips`, with their chips on the felt and their Diamonds. Null when
   *  the read was incomplete (fail closed: no pass). */
  loadMembers(maxChips: number): Promise<SpinMember[] | null>;
  /** One horse's membership as it stands now: 'gone' when it is no longer an
   *  active membership of a horse, null when the read failed. */
  loadMember(userId: string, clubId: string): Promise<SpinMember | 'gone' | null>;
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

/**
 * Chips each horse has on an open CASH seat paid from one of the host's
 * wallets, keyed `${userId}:${clubId}`. A tournament stack is tournament
 * chips, not the wallet's, and a Diamond Arena or Lightning seat is paid from
 * another wallet, so neither is counted. Null when a read was incomplete.
 */
async function loadFelt(userIds: string[]): Promise<Map<string, number> | null> {
  const wallets = WALLETS_FOR_HOST[MIDWAY_UNION_ID] ?? [];
  const felt = new Map<string, number>();
  if (userIds.length === 0 || wallets.length === 0) return felt;
  const seats = await selectInChunks<{
    user_id: string;
    club_id: string;
    table_id: string;
    stack: unknown;
  }>(
    userIds,
    (batch) =>
      supabase
        .from('table_seats')
        .select('user_id, club_id, table_id, stack')
        .is('left_at', null)
        .in('club_id', wallets)
        .in('user_id', batch),
    'HorseDiamondSpins.feltSeats'
  );
  if (!seats.complete) return null;
  if (seats.rows.length === 0) return felt;
  const cash = await selectInChunks<{ id: string }>(
    [...new Set(seats.rows.map((s) => String(s.table_id)))],
    (batch) =>
      supabase
        .from('tables')
        .select('id')
        .is('tournament_id', null)
        .eq('game_type', 'cash')
        .in('id', batch),
    'HorseDiamondSpins.feltTables'
  );
  if (!cash.complete) return null;
  const cashIds = new Set(cash.rows.map((t) => String(t.id)));
  for (const s of seats.rows) {
    if (!cashIds.has(String(s.table_id))) continue;
    const key = `${s.user_id}:${s.club_id}`;
    felt.set(key, (felt.get(key) ?? 0) + num(s.stack));
  }
  return felt;
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
    const felt = await loadFelt([...diamonds.keys()]);
    if (!felt) return null;
    return rows
      .filter((r) => diamonds.has(String(r.user_id)))
      .map((r) => ({
        userId: String(r.user_id),
        clubId: String(r.club_id),
        chips: num(r.chip_balance),
        feltChips: felt.get(`${r.user_id}:${r.club_id}`) ?? 0,
        diamonds: diamonds.get(String(r.user_id)) ?? 0,
      }));
  },
  async loadMember(userId, clubId) {
    const [m, p, felt] = await Promise.all([
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
      loadFelt([userId]),
    ]);
    if (m.error || p.error || !felt) return null;
    if (!m.data || !p.data) return 'gone';
    return {
      userId,
      clubId,
      chips: num(m.data.chip_balance),
      feltChips: felt.get(`${userId}:${clubId}`) ?? 0,
      diamonds: num(p.data.diamonds),
    };
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
  /** The cheapest open cash game the roster was measured against. */
  cheapestGame: CheapestGame | null;
  /** Horse wallets the fleet cannot seat at that game, at the last roster. */
  cannotBeSeated: number;
  /** Of those, how many have no Diamonds above the reserve to spin with:
   *  they wait on the Diamond Arena, freerolls and rakeback. */
  cannotSpinNoDiamonds: number;
  /** Horses with something to do at the last roster: a spin, a card or a
   *  bonus game. */
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
  cheapestGame: null,
  cannotBeSeated: 0,
  cannotSpinNoDiamonds: 0,
  inSession: 0,
  spins: 0,
  bonusesStarted: 0,
  moves: 0,
  cardsPicked: 0,
  refusals: {},
  errors: 0,
};

export function horseDiamondSpinsStatus(): HorseSpinStatus {
  return {
    ...status,
    cheapestGame: status.cheapestGame ? { ...status.cheapestGame } : null,
    refusals: { ...status.refusals },
  };
}

interface Roster {
  at: number;
  game: CheapestGame;
  states: HorseSpinState[];
  cannotBeSeated: number;
  cannotSpinNoDiamonds: number;
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
    cheapestGame: null,
    cannotBeSeated: 0,
    cannotSpinNoDiamonds: 0,
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
  // A wallet at or above the highest bar can never be under any horse's bar,
  // felt or no felt, so the read stops there.
  const members = await doors.loadMembers(maxSpinTargetChips(game));
  if (!members) return null;
  const empty = { at: doors.now(), game, states: [], cannotBeSeated: 0, cannotSpinNoDiamonds: 0 };
  if (members.length === 0) return empty;
  const ids = [...new Set(members.map((m) => m.userId))];
  const work = await doors.loadOpenWork(ids);
  if (!work) return null;

  const states: HorseSpinState[] = [];
  let stranded = 0;
  let strandedDry = 0;
  for (const m of members) {
    const roll = m.chips + m.feltChips;
    const inSession = cannotBeSeated(m.userId, roll, game);
    const own = <T extends { userId: string }>(xs: T[]) => xs.filter((x) => x.userId === m.userId);
    const state: HorseSpinState = {
      horseId: m.userId,
      clubId: m.clubId,
      chips: roll,
      diamonds: m.diamonds,
      targetChips: spinTargetChips(m.userId, game),
      inSession,
      cards: own(work.cards),
      awards: own(work.awards),
      crashRounds: own(work.crashRounds),
      choiceRounds: own(work.choiceRounds),
    };
    if (inSession) {
      stranded += 1;
      if (Math.floor(m.diamonds) - DIAMOND_RESERVE < SPIN_ENTRIES[0]) strandedDry += 1;
    }
    if (nextStep(state).kind !== 'rest') states.push(state);
  }
  return { ...empty, states, cannotBeSeated: stranded, cannotSpinNoDiamonds: strandedDry };
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
    status.cheapestGame = { ...roster.game };
    status.cannotBeSeated = roster.cannotBeSeated;
    status.cannotSpinNoDiamonds = roster.cannotSpinNoDiamonds;
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
    chips: m.chips + m.feltChips,
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
    `[HorseDiamondSpins] Running - horses the fleet cannot seat spin Diamonds every ${HORSE_DIAMOND_SPINS_TICK_MS / 1000}s pass`
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
