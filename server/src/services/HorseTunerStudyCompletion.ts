import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const TUNER_STUDY_MAX_HORSES = 2048;
const dateValid = (day: string) =>
  typeof day === 'string' &&
  DAY.test(day) &&
  Number.isFinite(Date.parse(day)) &&
  new Date(day).toISOString().slice(0, 10) === day;
const idsValid = (ids: unknown): ids is string[] =>
  Array.isArray(ids) &&
  ids.length <= TUNER_STUDY_MAX_HORSES &&
  ids.every(
    (id, index) => typeof id === 'string' && UUID.test(id) && (index === 0 || ids[index - 1] < id)
  );

/** A committed per-horse receipt is restart progress, not whole-study completion. */
export async function readRecordedHorseTunes(
  runDate: string
): Promise<
  Readonly<{ status: 'snapshot'; horseIds: readonly string[] }> | Readonly<{ status: 'unknown' }>
> {
  if (!dateValid(runDate)) return { status: 'unknown' };
  try {
    const { data, error } = await supabase
      .rpc('fn_horse_tuner_recorded_horses', {
        p_run_date: runDate,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (
      error ||
      data?.version !== 1 ||
      data.status !== 'snapshot' ||
      data.runDate !== runDate ||
      !idsValid(data.horseIds)
    )
      return { status: 'unknown' };
    return Object.freeze({ status: 'snapshot', horseIds: Object.freeze([...data.horseIds]) });
  } catch {
    return { status: 'unknown' };
  }
}

/** Certify the captured eligible cohort only after every atomic per-horse
 * receipt exists. This is execution completion, never causal-learning evidence. */
export async function completeHorseTunerStudy(
  runDate: string,
  studied: number,
  horseIds: readonly string[]
): Promise<boolean> {
  const ids = Array.isArray(horseIds) ? [...horseIds].sort() : null;
  if (
    !dateValid(runDate) ||
    !Number.isSafeInteger(studied) ||
    studied < 0 ||
    studied > TUNER_STUDY_MAX_HORSES ||
    !idsValid(ids) ||
    studied < ids.length
  )
    return false;
  const payload = JSON.stringify({ version: 1, runDate, studied, horseIds: ids });
  const digest = createHash('sha256').update(payload).digest('hex');
  try {
    const { data, error } = await supabase
      .rpc('fn_complete_horse_tuner_study', {
        p_payload: payload,
      })
      .abortSignal(AbortSignal.timeout(5000));
    return (
      !error &&
      data?.version === 1 &&
      data.status === 'recorded' &&
      data.runDate === runDate &&
      data.requestHash === digest &&
      data.eligible === ids.length &&
      typeof data.replayed === 'boolean'
    );
  } catch {
    return false;
  }
}

/** Freeze the eligible membership before the first write. A resumed attempt
 * receives the original membership even if today's source population changed. */
export async function prepareHorseTunerStudy(
  runDate: string,
  studied: number,
  horseIds: readonly string[]
): Promise<
  | Readonly<{ status: 'prepared'; studied: number; horseIds: readonly string[] }>
  | Readonly<{ status: 'unknown' }>
> {
  const ids = Array.isArray(horseIds) ? [...horseIds].sort() : null;
  if (
    !dateValid(runDate) ||
    !Number.isSafeInteger(studied) ||
    studied < 0 ||
    studied > TUNER_STUDY_MAX_HORSES ||
    !idsValid(ids) ||
    studied < ids.length
  )
    return { status: 'unknown' };
  const payload = JSON.stringify({ version: 1, runDate, studied, horseIds: ids });
  try {
    const { data, error } = await supabase
      .rpc('fn_prepare_horse_tuner_study', { p_payload: payload })
      .abortSignal(AbortSignal.timeout(5000));
    if (
      error ||
      data?.version !== 1 ||
      data.status !== 'prepared' ||
      typeof data.payload !== 'string' ||
      Buffer.byteLength(data.payload) > 100000 ||
      createHash('sha256').update(data.payload).digest('hex') !== data.requestHash
    )
      return { status: 'unknown' };
    const original = JSON.parse(data.payload);
    if (
      original.version !== 1 ||
      original.runDate !== runDate ||
      !Number.isSafeInteger(original.studied) ||
      original.studied < 0 ||
      original.studied > TUNER_STUDY_MAX_HORSES ||
      !idsValid(original.horseIds) ||
      original.studied < original.horseIds.length ||
      JSON.stringify({
        version: 1,
        runDate,
        studied: original.studied,
        horseIds: original.horseIds,
      }) !== data.payload
    )
      return { status: 'unknown' };
    return Object.freeze({
      status: 'prepared',
      studied: original.studied,
      horseIds: Object.freeze([...original.horseIds]),
    });
  } catch {
    return { status: 'unknown' };
  }
}
