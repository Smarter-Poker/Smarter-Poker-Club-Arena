/**
 * MULTI-DAY TOURNAMENTS ON THE CLIENT: THE STATUS, THE CLOCK AND THE PLAN.
 *
 * A multi-day event is ONE tournaments row. Between days it is `BAGGED`: every
 * stack is in a bag, no table is open, registration is closed, and the event is
 * neither finished nor cancelled (design:
 * docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md sections 3
 * and 7). Every reader that classifies a tournament status asks
 * `isBaggedStatus` rather than re-spelling the string, so a bagged event can
 * never fall through to a "finished", "cancelled" or "registering" default.
 *
 * Times: the database stores each day's start in UTC with the plan's IANA
 * zone beside it. The client prints the start in THAT zone ("Day 2 Starts Sat
 * 12:00 PM CDT"), never the viewer's, because the operator scheduled a local
 * time for a room. Converting an operator's wall time to UTC is done here with
 * Intl only; no date library.
 */
import type { PlatformCapabilityId } from '../config/platformCapabilities';

/**
 * The registry capability every multi-day surface asks
 * `usePlatformCapability` about. Kept here, with the feature, not in the
 * shared hook.
 */
export const MULTI_DAY_CAPABILITY: PlatformCapabilityId = 'tournament.multi_day.single_flight';

export const BAGGED_STATUS = 'BAGGED';

/** Between days: live, entries closed, not finished, not cancelled. */
export function isBaggedStatus(status: unknown): boolean {
  return String(status ?? '').toUpperCase() === BAGGED_STATUS;
}

/** The pill and badge label for a bagged event when the day number is unknown. */
export const DAY_COMPLETE_LABEL = 'Day Complete';

export function dayCompleteLabel(dayNo: number | null | undefined): string {
  return Number.isInteger(dayNo) && (dayNo as number) > 0
    ? `Day ${dayNo} Complete`
    : DAY_COMPLETE_LABEL;
}

/** Zones an operator can pick. The viewer's own zone is offered first. */
export const MULTI_DAY_TIME_ZONES: readonly string[] = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function viewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timeZoneOptions(): string[] {
  const own = viewerTimeZone();
  return [own, ...MULTI_DAY_TIME_ZONES.filter((z) => z !== own)];
}

type Parts = Record<string, string>;

function partsIn(date: Date, zone: string, options: Intl.DateTimeFormatOptions): Parts {
  const out: Parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).formatToParts(
    date
  )) {
    out[p.type] = p.value;
  }
  return out;
}

/** Offset of `zone` from UTC at `utcMs`, in milliseconds (east positive). */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const p = partsIn(new Date(utcMs), zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * An operator's wall time ("2026-10-03T12:00", as a datetime-local input gives
 * it) in `zone`, as an ISO UTC instant. Null when either input is unusable.
 */
export function zonedWallTimeToUtcIso(local: string, zone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local ?? '').trim());
  if (!m || !isValidTimeZone(zone)) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(wall)) return null;
  // Two passes settle the offset across a DST edge.
  let utc = wall - zoneOffsetMs(wall, zone);
  utc = wall - zoneOffsetMs(utc, zone);
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}

/** The inverse: a UTC instant as a datetime-local value in `zone`. */
export function utcIsoToZonedWallTime(iso: string, zone: string): string | null {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms) || !isValidTimeZone(zone)) return null;
  const p = partsIn(new Date(ms), zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  // hour is already two digits; one older ICU spells midnight "24" under h23.
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * "Sat 12:00 PM CDT" in the plan's zone; "Sat Oct 3 12:00 PM CDT" when the
 * start is more than six days away, so a weekday is never ambiguous.
 */
export function formatStageStart(
  iso: string | null | undefined,
  zone: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms) || !isValidTimeZone(zone)) return null;
  const p = partsIn(new Date(ms), zone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const when = `${p.hour}:${p.minute} ${String(p.dayPeriod ?? '').toUpperCase()} ${p.timeZoneName}`;
  return Math.abs(ms - nowMs) > SIX_DAYS_MS
    ? `${p.weekday} ${p.month} ${p.day} ${when}`
    : `${p.weekday} ${when}`;
}

export function nextDayStartsLabel(
  dayNo: number,
  iso: string | null | undefined,
  zone: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  const when = formatStageStart(iso, zone, nowMs);
  return when ? `Day ${dayNo} Starts ${when}` : null;
}

// ── The plan an operator submits ────────────────────────────────────────────

export interface StageDayDraft {
  /** Every day but the last ends after this published level. */
  endAfterLevel: number;
  /** Days 2+: the wall time in the plan's zone, as datetime-local gives it. */
  startsAtLocal: string;
}

export interface StagePlanDraft {
  timeZone: string;
  days: StageDayDraft[];
}

export interface SealedStagePlanBody {
  time_zone: string;
  stages: Array<{ stage_no: number; end_after_level?: number; scheduled_start_utc?: string }>;
}

export const MIN_DAYS = 2;
export const MAX_DAYS = 14;

export function defaultStagePlanDraft(): StagePlanDraft {
  return {
    timeZone: viewerTimeZone(),
    days: [
      { endAfterLevel: 12, startsAtLocal: '' },
      { endAfterLevel: 0, startsAtLocal: '' },
    ],
  };
}

/**
 * The body fn_operator_seal_stage_plan takes, or the first reason it would be
 * refused, in words. The database checks every rule again; this only saves the
 * operator a round trip and says which row is wrong.
 */
export function buildStagePlan(
  draft: StagePlanDraft,
  context: { entryLevels: number; day1StartUtc: string | null; nowMs?: number }
): { ok: true; plan: SealedStagePlanBody } | { ok: false; message: string } {
  const nowMs = context.nowMs ?? Date.now();
  if (!isValidTimeZone(draft.timeZone)) return { ok: false, message: 'Pick A Time Zone' };
  const n = draft.days.length;
  if (n < MIN_DAYS || n > MAX_DAYS) {
    return { ok: false, message: `A Multi-Day Event Has ${MIN_DAYS} To ${MAX_DAYS} Days` };
  }
  const stages: SealedStagePlanBody['stages'] = [];
  let prevEnd = 0;
  let prevStart = Date.parse(String(context.day1StartUtc ?? ''));
  for (let i = 0; i < n; i++) {
    const day = draft.days[i];
    const stage: SealedStagePlanBody['stages'][number] = { stage_no: i + 1 };
    if (i < n - 1) {
      const end = Math.round(Number(day.endAfterLevel));
      if (!Number.isInteger(end) || end <= prevEnd || end > 1000) {
        return {
          ok: false,
          message: `Day ${i + 1} Must End After A Later Level Than The Day Before`,
        };
      }
      if (i === 0 && end <= context.entryLevels) {
        return {
          ok: false,
          message: `Day 1 Must End After Level ${context.entryLevels.toLocaleString()}, When Entries Close`,
        };
      }
      stage.end_after_level = end;
      prevEnd = end;
    }
    if (i > 0) {
      const iso = zonedWallTimeToUtcIso(day.startsAtLocal, draft.timeZone);
      const ms = Date.parse(String(iso ?? ''));
      if (!iso || !Number.isFinite(ms)) {
        return { ok: false, message: `Set When Day ${i + 1} Starts` };
      }
      if (ms <= nowMs || (Number.isFinite(prevStart) && ms <= prevStart)) {
        return { ok: false, message: `Day ${i + 1} Must Start After Day ${i}` };
      }
      stage.scheduled_start_utc = iso;
      prevStart = ms;
    }
    stages.push(stage);
  }
  return { ok: true, plan: { time_zone: draft.timeZone, stages } };
}
