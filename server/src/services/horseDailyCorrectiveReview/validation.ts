import { isAbsolute } from 'node:path';
import {
  DAILY_LIMITS,
  type DailyCursor,
  type DailyManifest,
  type DailyPage,
  type DailyRequest,
  type DailyRow,
} from './contract.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function utcDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function utcTime(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(v) &&
    utcDay(v.slice(0, 10)) &&
    Number(v.slice(11, 13)) < 24 &&
    Number(v.slice(14, 16)) < 60 &&
    Number(v.slice(17, 19)) < 60
  );
}
export function cursor(v: unknown): v is DailyCursor {
  return (
    object(v) &&
    Object.keys(v).length === 3 &&
    utcTime(v.playedAt) &&
    uuid(v.handId) &&
    uuid(v.horseId)
  );
}
export const cursorKey = (v: DailyCursor) => `${v.playedAt}|${v.handId}|${v.horseId}`;
export function validateRequest(v: DailyRequest): void {
  if (
    !v ||
    !utcDay(v.day) ||
    (v.after !== null && (!cursor(v.after) || v.after.playedAt.slice(0, 10) !== v.day))
  )
    throw Error('invalid_daily_request');
}
function strings(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= 32 &&
    v.every((x) => typeof x === 'string' && Buffer.byteLength(x) <= 160)
  );
}
const label = (v: unknown) => v === null || (typeof v === 'string' && Buffer.byteLength(v) <= 64);
const money = (v: unknown) =>
  v === null ||
  (typeof v === 'string' &&
    v.length <= 64 &&
    /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v) &&
    Number.isFinite(Number(v)));
/** Detach exactly the bounded response before any asynchronous consumer sees it. */
export function parseDailyPage(raw: unknown, request: DailyRequest): DailyPage {
  validateRequest(request);
  const serialized = JSON.stringify(raw);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > DAILY_LIMITS.wireBytes)
    throw Error('daily_page_bounds');
  const p: unknown = JSON.parse(serialized);
  if (
    !object(p) ||
    p.version !== 1 ||
    p.source !== 'horse_commitment_reviews' ||
    p.day !== request.day ||
    !(p.after === null
      ? request.after === null
      : cursor(p.after) &&
        request.after !== null &&
        cursorKey(p.after) === cursorKey(request.after)) ||
    p.limit !== DAILY_LIMITS.pageRows ||
    !utcTime(p.readAt) ||
    !Array.isArray(p.rows) ||
    p.rows.length > DAILY_LIMITS.pageRows ||
    typeof p.hasMore !== 'boolean' ||
    typeof p.dayObservation !== 'string' ||
    !['present', 'missing'].includes(p.dayObservation) ||
    p.sourceCoverage !== 'not_established' ||
    p.identityBasis !== 'current_profile_is_horse' ||
    p.gtoVerified !== false ||
    p.activationAllowed !== false
  )
    throw Error('daily_page_mismatch');
  let previous = request.after ? cursorKey(request.after) : '';
  const rows: DailyRow[] = [];
  for (const r of p.rows) {
    if (
      !object(r) ||
      !utcTime(r.playedAt) ||
      r.playedAt.slice(0, 10) !== request.day ||
      !uuid(r.handId) ||
      !uuid(r.horseId) ||
      !uuid(r.tableId) ||
      typeof r.status !== 'string' ||
      !['retained_diagnostic', 'payload_unavailable'].includes(r.status) ||
      !(r.payloadHash === null || sha(r.payloadHash)) ||
      !label(r.variant) ||
      !label(r.format) ||
      typeof r.eligibility !== 'string' ||
      !['over_10bb', 'unknown'].includes(r.eligibility) ||
      !money(r.bigBlind) ||
      !money(r.committedBb) ||
      !strings(r.reasons) ||
      !strings(r.gaps)
    )
      throw Error('daily_row_invalid');
    const key = cursorKey(r as unknown as DailyCursor);
    if (key <= previous) throw Error('daily_cursor_order');
    previous = key;
    rows.push(
      Object.freeze({
        playedAt: r.playedAt,
        handId: r.handId,
        horseId: r.horseId,
        tableId: r.tableId,
        status: r.status as DailyRow['status'],
        payloadHash: r.payloadHash,
        variant: r.variant as string | null,
        format: r.format as string | null,
        eligibility: r.eligibility as DailyRow['eligibility'],
        bigBlind: r.bigBlind as string | null,
        committedBb: r.committedBb as string | null,
        reasons: Object.freeze([...r.reasons]),
        gaps: Object.freeze([...r.gaps]),
      })
    );
  }
  const last = rows.at(-1);
  const next = last
    ? { playedAt: last.playedAt, handId: last.handId, horseId: last.horseId }
    : null;
  if (
    (p.hasMore && rows.length !== DAILY_LIMITS.pageRows) ||
    !(p.next === null
      ? next === null
      : cursor(p.next) && next !== null && cursorKey(p.next) === cursorKey(next))
  )
    throw Error('daily_next_cursor_invalid');
  return Object.freeze({
    version: 1,
    source: 'horse_commitment_reviews',
    limit: 8,
    day: request.day,
    after: request.after ? Object.freeze({ ...request.after }) : null,
    readAt: p.readAt,
    rows: Object.freeze(rows),
    hasMore: p.hasMore,
    next: next ? Object.freeze(next) : null,
    dayObservation: p.dayObservation as DailyPage['dayObservation'],
    sourceCoverage: 'not_established',
    identityBasis: 'current_profile_is_horse',
    gtoVerified: false,
    activationAllowed: false,
  });
}
export function parseDailyManifest(raw: unknown): DailyManifest {
  if (
    !object(raw) ||
    raw.version !== 1 ||
    !utcDay(raw.day) ||
    typeof raw.journalDirectory !== 'string' ||
    raw.journalDirectory.length > 4096 ||
    raw.journalDirectory.includes('\0') ||
    !isAbsolute(raw.journalDirectory) ||
    (raw.after !== undefined &&
      raw.after !== null &&
      (!cursor(raw.after) || raw.after.playedAt.slice(0, 10) !== raw.day)) ||
    !Array.isArray(raw.mappings) ||
    raw.mappings.length > DAILY_LIMITS.hands
  )
    throw Error('daily_manifest_invalid');
  const seen = new Set<string>();
  const mappings = [];
  for (const x of raw.mappings) {
    if (
      !object(x) ||
      !uuid(x.handId) ||
      !uuid(x.tableId) ||
      !sha(x.handKey) ||
      typeof x.inputPath !== 'string' ||
      x.inputPath.length > 4096 ||
      x.inputPath.includes('\0') ||
      !isAbsolute(x.inputPath) ||
      (x.authorityPath !== undefined &&
        (typeof x.authorityPath !== 'string' ||
          x.authorityPath.length > 4096 ||
          x.authorityPath.includes('\0') ||
          !isAbsolute(x.authorityPath))) ||
      seen.has(x.handId)
    )
      throw Error('daily_mapping_invalid');
    seen.add(x.handId);
    mappings.push(
      Object.freeze({
        handId: x.handId,
        tableId: x.tableId,
        handKey: x.handKey,
        inputPath: x.inputPath,
        ...(typeof x.authorityPath === 'string' ? { authorityPath: x.authorityPath } : {}),
      })
    );
  }
  return Object.freeze({
    version: 1,
    day: raw.day,
    after: cursor(raw.after) ? Object.freeze({ ...raw.after }) : null,
    journalDirectory: raw.journalDirectory,
    mappings: Object.freeze(mappings),
  });
}
