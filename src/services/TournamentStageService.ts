/**
 * The three multi-day RPCs a browser may call (migration 20260924063656):
 *
 *   fn_tournament_stage_view      the day schedule, the caller's own bag and
 *                                 seat, and the post-bag chip leaders
 *   fn_operator_seal_stage_plan   seal an event's day plan (operators)
 *   fn_operator_reschedule_stage  move a scheduled day's start (operators)
 *
 * A read that fails or answers in a shape this build does not know is
 * `unknown`, never "no plan": the surfaces that depend on it show nothing
 * multi-day either way, but a caller that needs to tell the two apart can.
 */
import { supabase } from '../lib/supabase';
import type { SealedStagePlanBody } from '../utils/multiDaySchedule';

export type StageState =
  | 'planned'
  | 'running'
  | 'day_ending'
  | 'bagged'
  | 'scheduled'
  | 'resuming'
  | 'closed';

const STAGE_STATES: readonly StageState[] = [
  'planned',
  'running',
  'day_ending',
  'bagged',
  'scheduled',
  'resuming',
  'closed',
];

export interface StageRow {
  stageNo: number;
  dayNo: number;
  endAfterLevel: number | null;
  scheduledStartUtc: string | null;
  scheduleGeneration: number;
  state: StageState;
}

export interface NextStart {
  stageNo: number;
  dayNo: number;
  scheduledStartUtc: string;
  timeZone: string;
  scheduleGeneration: number;
  state: StageState;
}

export interface MyBag {
  stageNo: number;
  dayNo: number;
  stack: number;
  bountyHead: number;
}

export interface MySeat {
  stageNo: number;
  dayNo: number;
  tableId: string;
  tableName: string | null;
  seatNumber: number;
}

export interface ChipLeader {
  rank: number;
  displayName: string;
  stack: number;
}

export interface StagePlan {
  ruleVersion: string;
  timeZone: string;
  stageCount: number;
}

export interface TournamentStageView {
  tournamentId: string;
  status: string;
  /** Null when the event has no sealed plan: nothing multi-day is shown. */
  plan: StagePlan | null;
  stages: StageRow[];
  currentStage: { stageNo: number; dayNo: number; state: StageState } | null;
  nextStart: NextStart | null;
  bag: { stageNo: number; dayNo: number; players: number } | null;
  myBag: MyBag | null;
  mySeat: MySeat | null;
  chipLeaders: ChipLeader[];
}

export type StageViewRead =
  | { status: 'ok'; view: TournamentStageView }
  | { status: 'refused'; reason: string }
  | { status: 'unknown'; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const stageState = (v: unknown): StageState | null =>
  typeof v === 'string' && (STAGE_STATES as readonly string[]).includes(v)
    ? (v as StageState)
    : null;

class Malformed extends Error {}
const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Malformed(what);
  return v;
};

function parseView(raw: Obj): TournamentStageView {
  const tournamentId = need(str(raw.tournament_id), 'tournament_id');
  const status = need(str(raw.status), 'status');
  if (raw.plan === null || raw.plan === undefined) {
    return {
      tournamentId,
      status,
      plan: null,
      stages: [],
      currentStage: null,
      nextStart: null,
      bag: null,
      myBag: null,
      mySeat: null,
      chipLeaders: [],
    };
  }
  if (!isObj(raw.plan)) throw new Malformed('plan');
  const plan: StagePlan = {
    ruleVersion: need(str(raw.plan.rule_version), 'plan.rule_version'),
    timeZone: need(str(raw.plan.time_zone), 'plan.time_zone'),
    stageCount: need(int(raw.plan.stage_count), 'plan.stage_count'),
  };
  if (!Array.isArray(raw.stages)) throw new Malformed('stages');
  const stages: StageRow[] = raw.stages.map((s) => {
    if (!isObj(s)) throw new Malformed('stage');
    return {
      stageNo: need(int(s.stage_no), 'stage_no'),
      dayNo: need(int(s.day_no), 'day_no'),
      endAfterLevel: int(s.end_after_level),
      scheduledStartUtc: str(s.scheduled_start_utc),
      scheduleGeneration: need(int(s.schedule_generation), 'schedule_generation'),
      state: need(stageState(s.state), 'stage.state'),
    };
  });
  const cur = isObj(raw.current_stage) ? raw.current_stage : null;
  const next = isObj(raw.next_start) ? raw.next_start : null;
  const bag = isObj(raw.bag) ? raw.bag : null;
  const myBag = isObj(raw.my_bag) ? raw.my_bag : null;
  const mySeat = isObj(raw.my_seat) ? raw.my_seat : null;
  const leaders = Array.isArray(raw.chip_leaders) ? raw.chip_leaders : [];
  return {
    tournamentId,
    status,
    plan,
    stages,
    currentStage: cur
      ? {
          stageNo: need(int(cur.stage_no), 'current.stage_no'),
          dayNo: need(int(cur.day_no), 'current.day_no'),
          state: need(stageState(cur.state), 'current.state'),
        }
      : null,
    nextStart: next
      ? {
          stageNo: need(int(next.stage_no), 'next.stage_no'),
          dayNo: need(int(next.day_no), 'next.day_no'),
          scheduledStartUtc: need(str(next.scheduled_start_utc), 'next.start'),
          timeZone: need(str(next.time_zone), 'next.time_zone'),
          scheduleGeneration: need(int(next.schedule_generation), 'next.generation'),
          state: need(stageState(next.state), 'next.state'),
        }
      : null,
    bag: bag
      ? {
          stageNo: need(int(bag.stage_no), 'bag.stage_no'),
          dayNo: need(int(bag.day_no), 'bag.day_no'),
          players: need(int(bag.players), 'bag.players'),
        }
      : null,
    myBag: myBag
      ? {
          stageNo: need(int(myBag.stage_no), 'my_bag.stage_no'),
          dayNo: need(int(myBag.day_no), 'my_bag.day_no'),
          stack: need(num(myBag.stack), 'my_bag.stack'),
          bountyHead: need(num(myBag.bounty_head), 'my_bag.bounty_head'),
        }
      : null,
    mySeat: mySeat
      ? {
          stageNo: need(int(mySeat.stage_no), 'my_seat.stage_no'),
          dayNo: need(int(mySeat.day_no), 'my_seat.day_no'),
          tableId: need(str(mySeat.table_id), 'my_seat.table_id'),
          tableName: str(mySeat.table_name),
          seatNumber: need(int(mySeat.seat_number), 'my_seat.seat_number'),
        }
      : null,
    chipLeaders: leaders.map((l) => {
      if (!isObj(l)) throw new Malformed('leader');
      return {
        rank: need(int(l.rank), 'leader.rank'),
        displayName: need(str(l.display_name), 'leader.display_name'),
        stack: need(num(l.stack), 'leader.stack'),
      };
    }),
  };
}

export async function readTournamentStageView(tournamentId: string): Promise<StageViewRead> {
  const { data, error } = await supabase.rpc('fn_tournament_stage_view', {
    p_tournament_id: tournamentId,
  });
  if (error) return { status: 'unknown', reason: error.message || 'rpc_error' };
  if (!isObj(data)) return { status: 'unknown', reason: 'malformed_response' };
  if (data.ok !== true) {
    return { status: 'refused', reason: str(data.reason) ?? 'refused' };
  }
  try {
    return { status: 'ok', view: parseView(data) };
  } catch (e) {
    return {
      status: 'unknown',
      reason: e instanceof Malformed ? `malformed:${e.message}` : 'malformed',
    };
  }
}

export type StageDoorResult =
  | { ok: true; replay: boolean; raw: Obj }
  | { ok: false; reason: string };

async function door(fn: string, args: Record<string, unknown>): Promise<StageDoorResult> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, reason: error.message || 'rpc_error' };
  if (!isObj(data)) return { ok: false, reason: 'malformed_response' };
  if (data.ok === true) return { ok: true, replay: data.replay === true, raw: data };
  return { ok: false, reason: str(data.reason) ?? 'refused' };
}

export function sealStagePlan(tournamentId: string, plan: SealedStagePlanBody) {
  return door('fn_operator_seal_stage_plan', { p_tournament_id: tournamentId, p_plan: plan });
}

export function rescheduleStage(args: {
  tournamentId: string;
  stageNo: number;
  newStartUtc: string;
  expectedGeneration: number;
  reason: string;
}) {
  return door('fn_operator_reschedule_stage', {
    p_tournament_id: args.tournamentId,
    p_stage_no: args.stageNo,
    p_new_start_utc: args.newStartUtc,
    p_expected_generation: args.expectedGeneration,
    p_reason: args.reason,
  });
}

/** A refusal reason from either door, in the words an operator reads. */
export function stageRefusalMessage(reason: string): string {
  const known: Record<string, string> = {
    capability_unavailable: 'Multi-Day Tournaments Are Not Available Yet',
    not_authorised: 'You Cannot Manage Games In This Club',
    tournament_not_found: 'Tournament Not Found',
    tournament_not_plannable: 'The Day Schedule Can Only Be Set Before The Event Starts',
    players_registered: 'The Day Schedule Can Only Be Set Before Anyone Registers',
    format_not_multi_day: 'Only A Multi-Table Tournament Can Run Over Several Days',
    plan_already_sealed: 'This Tournament Already Has A Different Day Schedule',
    time_zone_unknown: 'That Time Zone Is Not Recognised',
    stage_count_out_of_range: 'A Multi-Day Event Has 2 To 14 Days',
    stage_end_level_invalid: 'Each Day Must End After A Later Level Than The Day Before',
    stage_start_invalid: 'Each Day Must Start In The Future And After The Day Before',
    entry_window_crosses_day_end:
      'Day 1 Must End After Late Registration, Rebuys And Add-Ons Close',
    plan_shape_invalid: 'The Day Schedule Is Incomplete',
    tournament_not_bagged: 'The Next Day Can Only Be Moved While The Event Is Between Days',
    stage_not_scheduled: 'That Day Is Not Waiting To Start',
    resume_already_claimed: 'That Day Is Already Starting',
    schedule_generation_stale: 'The Schedule Changed. Refresh And Try Again',
    start_not_in_future: 'Pick A Start Time In The Future',
    start_not_before_next_stage: 'That Day Must Start Before The Day After It',
    invalid_request: 'The Request Was Incomplete',
  };
  if (known[reason]) return known[reason];
  if (/SESSION_REVOKED/.test(reason)) return 'Your Session Is Signed Out. Sign In Again.';
  if (/Authentication required/i.test(reason)) return 'Sign In To Continue';
  return 'The Day Schedule Could Not Be Saved';
}
