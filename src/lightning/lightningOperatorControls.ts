/**
 * LIGHTNING PHASE 13: THE OPERATOR'S CONTROLS (Spec Phase 22: Operator
 * Controls, Emergency Drain, Cluster Freeze, Rollback).
 *
 * Two SECURITY DEFINER doors, granted to `authenticated` and `service_role`
 * and gated in the database exactly like the Phase 12 reads:
 *
 *   fn_lightning_operator_control(p_cluster_id, p_action, p_reason, p_args)
 *       the ONE writing door for every control below. Reason required (at
 *       least three characters), idempotent by p_args.request_id: a repeat of
 *       the same request id answers the first answer with idempotent:true.
 *   fn_lightning_rollout_readiness(p_cluster_id)
 *       read only: go / no go evidence for turning Lightning on.
 *
 * The client never decides an outcome. It sends the operator's choice with a
 * fresh request id, shows what the door says changed (before and after) and,
 * on a refusal, the door's code in plain words. A drain is a state machine
 * the database drives; this module only asks for it.
 *
 * LAWS THIS FILE KEEPS
 *   - No card is ever read or sent. No parser below names a card field.
 *   - Horses are players (Law 10.5). Nothing here reads or labels which
 *     players are horses; every count counts everyone.
 *   - Nothing here moves a player (Law 10.6). A drain returns the Cluster to
 *     Must Move in the database; the client navigates nobody.
 */
import { supabase } from '../lib/supabase';
import {
  bool,
  callDoor,
  enumLabel,
  interpretAnswer,
  listOf,
  modeBadge,
  num,
  objectOf,
  parseDrain,
  parseMatcher,
  text,
  type LightningDrain,
  type LightningMatcherState,
  type OperatorAnswer,
  type RpcClient,
} from './lightningOperatorApi';

// ─── The actions the door takes ────────────────────────────────────────────

export const OPERATOR_ACTIONS = [
  'pause',
  'resume',
  'disable_joins',
  'enable_joins',
  'drain',
  'freeze',
  'unfreeze',
  'enable_lightning',
  'disable_lightning',
  'set_matcher_version',
  'disable_matcher_version',
  'enable_matcher_version',
  'rollback_matcher_version',
  'set_flag',
] as const;

export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

export function isOperatorAction(value: string): value is OperatorAction {
  return (OPERATOR_ACTIONS as readonly string[]).includes(value);
}

/** The shortest reason the door accepts (REASON_REQUIRED below it). */
export const MIN_REASON_LENGTH = 3;

export function reasonIsValid(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LENGTH;
}

/**
 * The three actions that strand nothing but stop a Cluster hard: a drain, a
 * freeze and turning Lightning off. Each asks the operator to type the
 * Cluster's name before it will send.
 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<OperatorAction> = new Set<OperatorAction>([
  'drain',
  'freeze',
  'disable_lightning',
]);

export function isDestructive(action: OperatorAction): boolean {
  return DESTRUCTIVE_ACTIONS.has(action);
}

/** The words an operator types to confirm a destructive action: the
 *  Cluster's own name, or the action's word when the Cluster has none. */
export function confirmationPhrase(action: OperatorAction, clusterName: string | null): string {
  const name = clusterName?.trim();
  if (name) return name;
  return action === 'drain' ? 'DRAIN' : action === 'freeze' ? 'FREEZE' : 'DISABLE';
}

function squash(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Case and surrounding space do not matter; every other character does. */
export function confirmationMatches(typed: string, phrase: string): boolean {
  return squash(typed) === squash(phrase);
}

export const ACTION_LABELS: Record<OperatorAction, string> = {
  pause: 'Pause Cluster',
  resume: 'Resume Cluster',
  disable_joins: 'Disable Joins',
  enable_joins: 'Enable Joins',
  drain: 'Drain Lightning',
  freeze: 'Freeze Cluster',
  unfreeze: 'Unfreeze Cluster',
  enable_lightning: 'Enable Lightning',
  disable_lightning: 'Disable Lightning',
  set_matcher_version: 'Set Matcher Version',
  disable_matcher_version: 'Disable Matcher Version',
  enable_matcher_version: 'Enable Matcher Version',
  rollback_matcher_version: 'Roll Back Matcher',
  set_flag: 'Change Feature Flag',
};

/** What each action does, printed in its confirm dialog. */
export const ACTION_EXPLAINERS: Record<OperatorAction, string> = {
  pause:
    'Stops Conversions And Lightning Formation. Hands Already Dealt Finish And Settle; New Hands Wait At The Next Boundary.',
  resume: 'Returns The Cluster To Exactly The Mode It Was Paused From.',
  disable_joins:
    'New Players Cannot Enter The Lightning Pool. Everyone Already Seated Keeps Playing.',
  enable_joins: 'New Players May Enter The Lightning Pool Again.',
  drain:
    'Stops Joins And Formation, Lets Every Live Hand Finish And Settle, Closes Every Pool Session With Stacks Intact And Rebuilds The Must Move Tables. Hands Already Dealing Are Never Cut.',
  freeze:
    'Freezes The Cluster Through The Same Path As An Automatic Freeze. Live State Is Preserved As Evidence And An Alert Is Raised. Only A Platform Administrator Can Unfreeze It.',
  unfreeze: 'Lifts The Freeze. Platform Administrators Only.',
  enable_lightning:
    'Allows The Cluster To Convert To Lightning When Its Population Reaches The ON Threshold.',
  disable_lightning:
    'Turns Lightning Off. A Cluster That Is In Lightning Or Converting Is Drained First, So No Player Is Stranded.',
  set_matcher_version:
    'Sets The Live Matcher, Whose Current Version Becomes The Roll Back Target, Or The Candidate The Engine Compares It With. Only A Version The Database Matcher Runs Can Be Live.',
  disable_matcher_version:
    'Disables The Chosen Version. Disabling The Live Version Rolls The Cluster Back To The Previous Enabled One.',
  enable_matcher_version: 'Allows The Chosen Version To Be Used Again.',
  rollback_matcher_version: 'Returns The Live Matcher To The Previous Version.',
  set_flag: 'Changes One Feature Flag For This Cluster Only.',
};

// ─── Feature flags (the Spec's names, mapped onto existing gates) ───────────

export const SPEC_FLAGS = [
  'lightning_v1',
  'lightning_fast_fold',
  'lightning_fold_watch',
  'lightning_multi_table',
  'lightning_pool_health',
  'lightning_repeat_suppression',
  'lightning_session_stats',
  'lightning_shadow_matcher',
  'lightning_auto_rebuy',
  'lightning_adaptive_liquidity',
] as const;

export type SpecFlag = (typeof SPEC_FLAGS)[number];

export const FLAG_LABELS: Record<SpecFlag, string> = {
  lightning_v1: 'Lightning',
  lightning_fast_fold: 'Lightning Fold',
  lightning_fold_watch: 'Fold & Watch',
  lightning_multi_table: 'Multi Table',
  lightning_pool_health: 'Pool Health',
  lightning_repeat_suppression: 'Repeat Suppression',
  lightning_session_stats: 'Session Stats',
  lightning_shadow_matcher: 'Shadow Matcher',
  lightning_auto_rebuy: 'Auto Rebuy',
  lightning_adaptive_liquidity: 'Adaptive Liquidity',
};

export function flagLabel(flag: string): string {
  return (
    (FLAG_LABELS as Record<string, string>)[flag] ?? enumLabel(flag.replace(/^lightning_/, ''))
  );
}

/**
 * The flags an operator can switch for one Cluster (20261009235505's
 * mapping): lightning_v1 is Enable / Disable Lightning itself (off on a live
 * Cluster IS the drain), so it is not switched from the flag list. Pool
 * Health, Session Stats, Repeat Suppression and Adaptive Liquidity are
 * always on by design: the door answers FLAG_NOT_SUPPORTED, so no switch is
 * offered (the first two protect nothing when off, the last two are the live
 * matcher's own and change only through a matcher version).
 */
export const SWITCHABLE_FLAGS: ReadonlySet<string> = new Set([
  'lightning_fast_fold',
  'lightning_fold_watch',
  'lightning_multi_table',
  'lightning_shadow_matcher',
  'lightning_auto_rebuy',
]);

/** The Spec flags the row reports, in the Spec's order, each with its
 *  effective value (null: the door did not report it). */
export function specFlags(
  values: Record<string, boolean | null>
): Array<{ flag: SpecFlag; value: boolean | null }> {
  return SPEC_FLAGS.filter((flag) => flag in values).map((flag) => ({
    flag,
    value: values[flag] ?? null,
  }));
}

// ─── Matcher versions ──────────────────────────────────────────────────────

/** The versions the platform knows: the SQL matcher's own and the engine's
 *  candidates. The door is the judge; this only fills the picker. */
export const KNOWN_MATCHER_VERSIONS = ['m1', 'm1-port', 'm2'] as const;

export function matcherVersionChoices(matcher: LightningMatcherState | null): string[] {
  const out: string[] = [...KNOWN_MATCHER_VERSIONS];
  const seen = [
    matcher?.version,
    matcher?.previous,
    matcher?.shadowVersion,
    ...(matcher?.disabled ?? []),
  ];
  for (const v of seen) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// ─── fn_lightning_operator_control ─────────────────────────────────────────

/** The Cluster's controllable state, as the door answers it before and after. */
export interface ControlState {
  mode: string | null;
  lightningEnabled: boolean | null;
  paused: boolean | null;
  joinsEnabled: boolean | null;
  drain: LightningDrain | null;
  matcher: LightningMatcherState | null;
}

export function parseControlState(raw: unknown): ControlState | null {
  const r = objectOf(raw);
  if (!r) return null;
  return {
    mode: text(r.cluster_mode),
    lightningEnabled: bool(r.lightning_enabled),
    paused: bool(r.paused),
    joinsEnabled: bool(r.joins_enabled),
    drain: parseDrain(r.drain),
    matcher: parseMatcher(r.matcher),
  };
}

export interface ControlResult {
  idempotent: boolean;
  /** The Cluster was already in the asked-for state: nothing written. */
  already: boolean;
  /** The same request id was answered before: the first answer, again. */
  replayed: boolean;
  action: string | null;
  clusterId: string | null;
  requestId: string | null;
  before: ControlState | null;
  after: ControlState | null;
  eventId: string | null;
}

export function parseControlResult(row: Record<string, unknown>): ControlResult | null {
  if (row.ok !== true) return null;
  const event = row.event_id;
  return {
    idempotent: row.idempotent === true,
    already: row.already === true,
    replayed: row.replayed === true,
    action: text(row.action),
    clusterId: text(row.cluster_id),
    requestId: text(row.request_id),
    before: parseControlState(row.before),
    after: parseControlState(row.after),
    eventId:
      typeof event === 'number' || (typeof event === 'string' && event.trim() !== '')
        ? String(event)
        : null,
  };
}

/** A fresh request id. crypto.randomUUID is missing from a few embedded
 *  webviews, so fall back to v4 from getRandomValues rather than throw. */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => (b + 0x100).toString(16).slice(1)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sendOperatorControl(
  clusterId: string,
  action: OperatorAction,
  reason: string,
  args: Record<string, unknown> & { request_id: string },
  client: RpcClient = supabase
): Promise<OperatorAnswer<ControlResult>> {
  return callDoor(
    'fn_lightning_operator_control',
    () =>
      client.rpc('fn_lightning_operator_control', {
        p_cluster_id: clusterId,
        p_action: action,
        p_reason: reason.trim(),
        p_args: args,
      }),
    (raw) => interpretAnswer(raw, parseControlResult)
  );
}

/** Every refusal the door gives, in an operator's words. */
export const REFUSAL_WORDS: Record<string, string> = {
  NOT_AUTHORIZED: 'Only Club Owners And Administrators Can Use Operator Controls.',
  REASON_REQUIRED: 'A Reason Of At Least Three Characters Is Required.',
  INVALID_ACTION: 'Lightning Does Not Recognize This Control.',
  INVALID_ARGS: 'The Control Was Sent With Missing Or Invalid Details.',
  CLUSTER_NOT_FOUND: 'This Cluster No Longer Exists.',
  CLUSTER_FROZEN: 'The Cluster Is Frozen. Only A Platform Administrator Can Unfreeze It.',
  CLUSTER_BUSY: 'A Conversion Or Drain Is In Progress. Try Again When It Finishes.',
  UNKNOWN_VERSION: 'That Matcher Version Is Not Known.',
  VERSION_DISABLED: 'That Matcher Version Is Disabled.',
  NOT_SQL_MATCHER: 'That Version Runs Only As A Candidate, Never As The Live Matcher.',
  FLAG_NOT_SUPPORTED: 'That Feature Flag Cannot Be Changed For One Cluster.',
  ALREADY: 'The Cluster Is Already In That State. Nothing Changed.',
  NOT_FOUND: 'This Cluster No Longer Exists.',
  IDEMPOTENCY_CONFLICT: 'This Request Was Already Used For A Different Control.',
};

export function refusalWords(code: string): string {
  return REFUSAL_WORDS[code] ?? `Lightning Refused This Control: ${enumLabel(code)}.`;
}

// ─── Before and after, in a line each ──────────────────────────────────────

export interface StateChange {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

function yesNo(v: boolean | null, yes: string, no: string): string {
  return v === null ? 'Unknown' : v ? yes : no;
}

function drainLine(d: LightningDrain | null): string {
  if (!d) return 'None';
  return drainPhaseLabel(d.phase);
}

function matcherLine(m: LightningMatcherState | null): string {
  if (!m || !m.version) return 'Unknown';
  return m.disabled.length ? `${m.version}, ${m.disabled.length} Disabled` : m.version;
}

/** The six controllable facts, before and after, the changed ones flagged. */
export function stateChanges(
  before: ControlState | null,
  after: ControlState | null
): StateChange[] {
  const rows: Array<[string, (s: ControlState | null) => string]> = [
    ['Mode', (s) => (s?.mode ? modeBadge(s.mode).label : 'Unknown')],
    ['Lightning', (s) => yesNo(s?.lightningEnabled ?? null, 'On', 'Off')],
    ['Paused', (s) => yesNo(s?.paused ?? null, 'Yes', 'No')],
    ['Joins', (s) => yesNo(s?.joinsEnabled ?? null, 'Open', 'Closed')],
    ['Drain', (s) => drainLine(s?.drain ?? null)],
    ['Matcher', (s) => matcherLine(s?.matcher ?? null)],
  ];
  return rows.map(([label, read]) => {
    const b = read(before);
    const a = read(after);
    return { label, before: b, after: a, changed: b !== a };
  });
}

// ─── The drain's steps ─────────────────────────────────────────────────────

/** lightning_cluster_drain.phase (20261009235505). */
const DRAIN_PHASE_LABELS: Record<string, string> = {
  finishing: 'Finishing Hands',
  reverting: 'Returning To Must Move',
  complete: 'Complete',
};

export function drainPhaseLabel(phase: string | null): string {
  if (!phase) return 'In Progress';
  return DRAIN_PHASE_LABELS[phase] ?? enumLabel(phase);
}

/** "1m 40s Left", "Passed": the time a drain has before it abandons the
 *  instances that never started dealing. Never a negative number. */
export function deadlineLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'None';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Unknown';
  const secs = Math.floor((at - now) / 1000);
  if (secs <= 0) return 'Passed';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s Left` : `${s}s Left`;
}

export function deadlineSeconds(iso: string | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor((at - now) / 1000) : null;
}

// ─── fn_lightning_rollout_readiness ────────────────────────────────────────

export type ReadinessVerdict = 'go' | 'no_go' | 'insufficient_evidence';

export const READINESS_LABELS: Record<ReadinessVerdict, string> = {
  go: 'Go',
  no_go: 'No Go',
  insufficient_evidence: 'Insufficient Evidence',
};

/** Every reason code the readiness door gives, in an operator's words. */
export const READINESS_REASON_WORDS: Record<string, string> = {
  MIGRATIONS_MISSING: 'Lightning Migrations Are Missing From The Database',
  MIGRATION_LEDGER_UNREADABLE: 'The Migration Ledger Could Not Be Read',
  INVARIANT_FAILED: 'A Structural Lightning Invariant Failed',
  CLUSTER_FROZEN: 'The Cluster Is Frozen',
  CLUSTER_BUSY: 'A Conversion, Pause Or Drain Is In Progress',
  CLUSTER_NOT_READY: 'The Cluster Is Not In Must Move Or Lightning',
  GAME_DISABLED: 'The Game Is Disabled',
  NOT_A_MUST_MOVE_GAME: 'The Game Is Not A Must Move Game',
  OPEN_ALERTS: 'Lightning Alerts Are Open',
  INTEGRITY_HIGH_SIGNALS_OPEN: 'High Severity Integrity Signals Are Open',
  LATENCY_ABOVE_CEILING: 'Action Latency Is Above Its Ceiling',
  MATCHER_VERSION_INVALID: 'The Live Matcher Version Is Invalid',
  AA_CALIBRATION_BIAS: 'The Live Matcher Disagrees With Its Own Port',
  WORKER_OFF: 'The Lightning Worker Is Off, So No Hands Would Form',
  NO_AA_CALIBRATION: 'No A/A Calibration Of The Live Matcher Yet',
  NO_LATENCY_EVIDENCE: 'No Latency Window In The Last 24 Hours',
  WORKER_SHADOW_ONLY: 'The Worker Runs In Shadow Only And Forms No Hands',
};

export interface ReadinessReason {
  code: string;
  /** 'blocking' makes the verdict No Go; 'evidence' makes it Insufficient. */
  severity: 'blocking' | 'evidence' | null;
  text: string;
  /** A count or a short list the door attached; never the raw paragraph. */
  detail: string | null;
}

export interface ReadinessCheck {
  label: string;
  ok: boolean | null;
  detail: string | null;
}

export interface LightningReadiness {
  clusterId: string | null;
  asOf: string | null;
  verdict: ReadinessVerdict | null;
  reasons: ReadinessReason[];
  checks: ReadinessCheck[];
}

/** A reason's detail when it is a figure or a list of names; anything else
 *  (an object, an engineer's sentence) stays in the database. */
function reasonDetail(v: unknown): string | null {
  const n = num(v);
  if (n !== null && typeof v !== 'string') return n.toLocaleString('en-US');
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
    return v.length > 4 ? `${v.slice(0, 4).join(', ')} And ${v.length - 4} More` : v.join(', ');
  }
  return null;
}

function reasonOf(raw: unknown): ReadinessReason | null {
  const r = objectOf(raw);
  const code = r ? text(r.code) : null;
  if (!r || !code) return null;
  const sev = text(r.severity);
  return {
    code,
    severity: sev === 'blocking' || sev === 'evidence' ? sev : null,
    text: READINESS_REASON_WORDS[code] ?? enumLabel(code),
    detail: reasonDetail(r.detail),
  };
}

function yes(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** The evidence object, as rows an operator can read down. */
export function readinessChecks(evidence: Record<string, unknown> | null): ReadinessCheck[] {
  if (!evidence) return [];
  const out: ReadinessCheck[] = [];
  const mig = objectOf(evidence.migrations);
  if (mig) {
    const missing = Array.isArray(mig.missing) ? mig.missing.length : null;
    const applied = num(mig.applied);
    const expected = num(mig.expected);
    out.push({
      label: 'Lightning Migrations Applied',
      ok: missing === null ? null : missing === 0,
      detail: applied !== null && expected !== null ? `${applied} / ${expected}` : null,
    });
  }
  const inv = objectOf(evidence.invariants);
  if (inv) {
    out.push({ label: 'Seven Tables Census', ok: yes(inv.seven_tables), detail: null });
    out.push({ label: 'Anti Manipulation Pin', ok: yes(inv.anti_manipulation), detail: null });
    out.push({ label: 'Every Player Treated Alike', ok: yes(inv.law_10_5), detail: null });
    out.push({ label: 'No Anonymous Door', ok: yes(inv.no_anon_door), detail: null });
  }
  const cl = objectOf(evidence.cluster);
  if (cl) {
    const live = num(cl.live_eligible);
    const on = num(cl.on_threshold);
    out.push({
      label: 'Live Eligible / On Threshold',
      ok: yes(cl.would_turn_on),
      detail:
        live !== null && on !== null
          ? `${live.toLocaleString('en-US')} / ${on.toLocaleString('en-US')}`
          : null,
    });
    const worker = text(cl.worker_mode);
    out.push({
      label: 'Worker',
      ok: worker === null ? null : worker !== 'off' && worker !== 'shadow',
      detail: worker ? enumLabel(worker) : null,
    });
  }
  const alerts = objectOf(evidence.alerts);
  if (alerts) {
    const open = num(alerts.open);
    out.push({
      label: 'Open Alerts',
      ok: open === null ? null : open === 0,
      detail: open === null ? null : String(open),
    });
  }
  const integ = objectOf(evidence.integrity);
  if (integ) {
    const high = num(integ.open_high);
    out.push({
      label: 'High Integrity Signals Open',
      ok: high === null ? null : high === 0,
      detail: high === null ? null : String(high),
    });
  }
  const shadow = objectOf(evidence.shadow);
  if (shadow) {
    const aa = objectOf(shadow.aa_calibration);
    const aaVerdict = aa ? text(aa.verdict) : null;
    out.push({
      label: 'A/A Calibration',
      ok: aaVerdict === null ? null : aaVerdict === 'calibrated',
      detail: aaVerdict ? enumLabel(aaVerdict) : 'None',
    });
    const cand = objectOf(shadow.candidate);
    const candVerdict = cand ? text(cand.verdict) : null;
    const candVersion = cand ? text(cand.shadow_matcher_version) : null;
    out.push({
      label: candVersion ? `Candidate ${candVersion}` : 'Candidate',
      ok: null,
      detail: candVerdict ? enumLabel(candVerdict) : 'No Comparisons',
    });
  }
  const lat = objectOf(evidence.latency);
  if (lat) {
    const over = Array.isArray(lat.over) ? lat.over.length : null;
    out.push({
      label: 'Latency Within Ceilings',
      ok: over === null ? null : over === 0,
      detail: over ? `${over} ${over === 1 ? 'Leg' : 'Legs'} Over` : null,
    });
  }
  return out;
}

export function parseReadiness(row: Record<string, unknown>): LightningReadiness | null {
  const verdictText = text(row.verdict);
  const verdict: ReadinessVerdict | null =
    verdictText === 'go' || verdictText === 'no_go' || verdictText === 'insufficient_evidence'
      ? verdictText
      : null;
  if (!verdict || !Array.isArray(row.reasons)) return null;
  return {
    clusterId: text(row.cluster_id),
    asOf: text(row.as_of),
    verdict,
    reasons: listOf(row.reasons)
      .map(reasonOf)
      .filter((r): r is ReadinessReason => r !== null),
    checks: readinessChecks(objectOf(row.evidence)),
  };
}

export function fetchRolloutReadiness(
  clusterId: string,
  client: RpcClient = supabase
): Promise<OperatorAnswer<LightningReadiness>> {
  return callDoor(
    'fn_lightning_rollout_readiness',
    () => client.rpc('fn_lightning_rollout_readiness', { p_cluster_id: clusterId }),
    (raw) => interpretAnswer(raw, parseReadiness)
  );
}
