/**
 * LEAGUE-GATED SELF-TUNER NUDGES (Dan 2026-10-19: "League-gated nudges").
 *
 * The nightly tuner proposes +/-0.02 moves on three dials. Phase 14's
 * corrective path, which needs a qualified reference producer, an independent
 * signer and an applier, stays inactive and untouched. This is a narrower door
 * with the same evidence standard as every brain layer: a dial move in a given
 * direction reaches a live horse only after its league matchup
 * (tuner_<dial>_<up|down>, HorseLeague card) pools significant positive -
 * at least 3 measured runs in 30 days and pooled bb/100 above 2 x the pooled
 * stderr.
 *
 * Two independent switches: HORSE_TUNER_LEAGUE_GATED_APPLY=1 in the engine
 * environment (default unset = observational only, exactly as before), and
 * the database's own re-check of the evidence in
 * fn_apply_league_gated_horse_tuner_nudge. The caller cannot claim admission.
 *
 * Only tightness, aggression and bluffFreq move. Leak counts, persona and
 * every authored key are carried over unchanged. Never "bots" - horses.
 */
import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

export type TunerDial = 'tightness' | 'aggression' | 'bluffFreq';
export const TUNER_DIALS: readonly TunerDial[] = ['tightness', 'aggression', 'bluffFreq'];

/** The league class a move belongs to, e.g. tightness +0.02 -> 'tightness_up'. */
export function tunerMoveClass(dial: TunerDial, before: number, after: number): string | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || after === before) return null;
  const slug = dial === 'bluffFreq' ? 'bluff' : dial;
  return `${slug}_${after > before ? 'up' : 'down'}`;
}

export function leagueGatedApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HORSE_TUNER_LEAGUE_GATED_APPLY === '1';
}

/**
 * Keep only the dial moves whose class is admitted. A move the league has not
 * proven stays at its current value. Returns null when nothing survives.
 */
export function admittedDialMoves(
  before: Readonly<Partial<Record<TunerDial, number>>>,
  proposed: Readonly<Partial<Record<TunerDial, number>>>,
  admitted: ReadonlySet<string>
): { mods: Record<TunerDial, number>; classes: string[] } | null {
  const mods = {} as Record<TunerDial, number>;
  const classes: string[] = [];
  for (const dial of TUNER_DIALS) {
    const b = before[dial] ?? 1;
    const p = proposed[dial] ?? b;
    const cls = tunerMoveClass(dial, b, p);
    if (cls && admitted.has(cls) && Math.abs(p - b) <= 0.02 + 1e-9 && p >= 0.85 && p <= 1.18) {
      mods[dial] = p;
      classes.push(cls);
    } else {
      mods[dial] = b;
    }
  }
  return classes.length ? { mods, classes } : null;
}

/** The admitted classes, or null when the answer is unknown (never assume). */
export async function readAdmittedTunerClasses(): Promise<Set<string> | null> {
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_tuner_admitted_classes')
      .abortSignal(AbortSignal.timeout(5000));
    if (error || !Array.isArray(data)) return null;
    return new Set(data.filter((x): x is string => typeof x === 'string'));
  } catch {
    return null;
  }
}

export type LeagueNudgeResult =
  | Readonly<{ status: 'applied'; classes: string[]; replayed: boolean }>
  | Readonly<{ status: 'unavailable'; reason: string }>
  | Readonly<{ status: 'unknown' }>;

export async function applyLeagueGatedNudge(input: {
  horseId: string;
  runDate: string;
  expectedProfile: Record<string, unknown>;
  mods: Record<TunerDial, number>;
}): Promise<LeagueNudgeResult> {
  let payload: string;
  try {
    const nextProfile: Record<string, unknown> = { ...input.expectedProfile };
    for (const dial of TUNER_DIALS) nextProfile[dial] = input.mods[dial];
    payload = JSON.stringify({
      version: 1,
      horseId: input.horseId,
      runDate: input.runDate,
      expectedProfile: input.expectedProfile,
      nextProfile,
    });
    if (Buffer.byteLength(payload, 'utf8') > 65536)
      return Object.freeze({ status: 'unavailable', reason: 'request_budget_exceeded' });
  } catch {
    return Object.freeze({ status: 'unavailable', reason: 'invalid_request' });
  }
  const requestHash = createHash('sha256').update(payload).digest('hex');
  try {
    const { data, error } = await supabase
      .rpc('fn_apply_league_gated_horse_tuner_nudge', { p_payload: payload })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return Object.freeze({ status: 'unknown' });
    if (data?.version === 1 && data.status === 'unavailable' && typeof data.reason === 'string')
      return Object.freeze({ status: 'unavailable', reason: data.reason });
    if (
      data?.version !== 1 ||
      data.status !== 'applied' ||
      data.requestHash !== requestHash ||
      data.horseId !== input.horseId ||
      !Array.isArray(data.classes) ||
      typeof data.replayed !== 'boolean'
    )
      return Object.freeze({ status: 'unknown' });
    return Object.freeze({
      status: 'applied',
      classes: data.classes.filter((x: unknown): x is string => typeof x === 'string'),
      replayed: data.replayed,
    });
  } catch {
    return Object.freeze({ status: 'unknown' });
  }
}
