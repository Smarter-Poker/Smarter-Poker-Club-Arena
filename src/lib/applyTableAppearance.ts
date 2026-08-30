/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE WRITER FOR TABLE APPEARANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "if a user changes their avatar, deck color, table,
 * background, button or anything else... it needs to change, save and update
 * in real time on the felt."
 *
 * WHY THIS FILE EXISTS. The felt reads its appearance from exactly one place —
 * `user_theme_settings` via `useUserThemeSettings` (TablePage: `resolveSkin`,
 * `resolveBackgroundLayers`, `activeCardBack`, and the `data-*-theme`
 * attributes). Historically, three surfaces hand-rolled this upsert and a
 * fourth wrote a different setting altogether. The hamburger card tiles even
 * selected an entire row and spread immutable columns back into PostgREST;
 * the retired /settings dropdown saved `useTableSettings.cardBack`, while
 * gameplay always preferred the non-empty `cards_id`, so it could announce
 * success without repainting the dealt cards.
 *
 * Table Studio is now the one selectable-appearance owner, and every launcher
 * mounts that same component. This module remains its one mutation path: emit
 * first so every open felt repaints instantly, write only the columns being
 * changed, and revert the exact optimistic field if persistence fails.
 *
 * It deliberately does NOT own reading. `useUserThemeSettings` remains the one
 * reader; a writer that also reads is how the two drift apart again.
 */

import { supabase } from './supabase';
import { masterBus } from '../core/MasterBus';
import { capture } from './analytics';
import { recordCustomizationOperation } from '../services/CustomizationOperationsTelemetry';

/** The five columns of `user_theme_settings` the felt actually paints from. */
export interface AppearancePatch {
  theme_id?: string;
  table_id?: string;
  button_id?: string;
  background_id?: string;
  cards_id?: string;
}

export interface ApplyAppearanceResult {
  ok: boolean;
  /** Present when the write failed; the caller decides how loudly to say so. */
  error?: unknown;
  /** The subset that was still current and therefore visibly rolled back. */
  reverted?: AppearancePatch;
}

const APPEARANCE_FIELDS = [
  'theme_id',
  'table_id',
  'button_id',
  'background_id',
  'cards_id',
] as const satisfies readonly (keyof AppearancePatch)[];

/* One ordered tail per database row. Two fast taps used to launch two upserts
   concurrently, allowing the slower FIRST request to finish last and become
   the durable selection. Partial writes protect unrelated fields; this queue
   protects the ordering of repeated changes to the same row. */
const writeTails = new Map<string, Promise<void>>();
const latestFieldRevision = new Map<string, number>();
const durableFieldValue = new Map<string, string>();
const pendingWriteCount = new Map<string, number>();
let appearanceRevision = 0;

// A browser fetch can remain pending long after the database has recovered.
// Without an abort boundary that request also holds the per-row write queue,
// leaving every later tap on "Applying..." forever. Normal production writes
// complete well inside this window; one bounded retry covers a transient edge
// or pool stall without allowing two different appearance writes to overlap.
const APPEARANCE_WRITE_TIMEOUT_MS = 25_000;
const APPEARANCE_WRITE_ATTEMPTS = 2;

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function retryableAppearanceWriteError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  const name = typeof record?.name === 'string' ? record.name : '';
  const code = typeof record?.code === 'string' ? record.code : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error || '');
  return (
    name === 'AbortError' ||
    /^PGRST00[013]$/.test(code) ||
    /abort|network|fetch|timeout|timed out|connection/i.test(message)
  );
}

async function persistAppearancePatch(
  userId: string,
  gameType: string,
  patch: AppearancePatch
): Promise<unknown | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= APPEARANCE_WRITE_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APPEARANCE_WRITE_TIMEOUT_MS);
    try {
      const request = supabase
        .from('user_theme_settings')
        .upsert(
          { user_id: userId, game_type: gameType, ...patch },
          { onConflict: 'user_id,game_type' }
        );
      // PostgREST builders support abortSignal. The conditional keeps the
      // writer compatible with the deliberately tiny promise-only test mock.
      const result =
        typeof request.abortSignal === 'function'
          ? await request.abortSignal(controller.signal)
          : await request;
      if (!result.error) return undefined;
      lastError = result.error;
      if (!retryableAppearanceWriteError(lastError)) return lastError;
    } catch (error) {
      lastError = error;
      if (!retryableAppearanceWriteError(error)) return error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return lastError ?? new Error('appearance write did not complete');
}

function recordAppearanceResult(
  outcome: 'saved' | 'failed' | 'guest' | 'empty',
  startedAt: number,
  gameType: string,
  patch: AppearancePatch,
  userId: string | null | undefined
): void {
  const fields = APPEARANCE_FIELDS.filter((field) => Boolean(patch[field]));
  const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
  const signedIn = Boolean(userId);
  capture('table_appearance_apply', {
    outcome,
    game_type: gameType,
    fields,
    field_count: fields.length,
    signed_in: signedIn,
    // End-to-end time deliberately includes time waiting behind a rapid-tap
    // write. That is the latency the player actually experiences.
    duration_ms: durationMs,
  });
  if (outcome === 'saved' || outcome === 'failed') {
    recordCustomizationOperation({
      userId,
      event: outcome === 'saved' ? 'appearance_saved' : 'appearance_failed',
      surface: 'table-studio',
      category: fields.join(':'),
      durationMs,
      reasonCode: outcome === 'failed' ? 'persistence_write' : undefined,
    });
  }
}

function emitAppearance(
  gameType: string,
  patch: AppearancePatch,
  userId: string | null | undefined,
  mutationId: string
): void {
  if (!Object.keys(patch).length) return;
  masterBus.emit('UI_THEME_CHANGED', {
    key: gameType,
    value: patch,
    userId: userId || undefined,
    mutationId,
  });
  if (patch.cards_id) {
    masterBus.emit('SETTINGS_CHANGED', {
      setting: 'cardBack',
      value: patch.cards_id,
      userId: userId || undefined,
    });
  }
}

/**
 * Apply an appearance change everywhere, at once.
 *
 * @param patch     only the columns being changed — never a whole row.
 * @param opts.userId    signed-in user. Without one the change is applied
 *                       LIVE but not persisted, and `ok` is false so the
 *                       caller can say why rather than showing a false tick.
 * @param opts.gameType  which bucket to write. 'ALL' is the global default and
 *                       is what every non-per-variant surface should use.
 * @param opts.previous  what to put back if the write fails. Supply it and a
 *                       failed save visibly reverts instead of leaving the
 *                       felt showing something the server never accepted.
 */
export async function applyTableAppearance(
  patch: AppearancePatch,
  opts: { userId?: string | null; gameType?: string; previous?: AppearancePatch }
): Promise<ApplyAppearanceResult> {
  const startedAt = nowMs();
  const gameType = opts.gameType || 'ALL';
  const cleanPatch: AppearancePatch = {};
  for (const field of APPEARANCE_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string' && value) cleanPatch[field] = value;
  }
  if (!Object.keys(cleanPatch).length) {
    recordAppearanceResult('empty', startedAt, gameType, cleanPatch, opts.userId);
    return { ok: false, error: new Error('appearance patch is empty') };
  }

  const scope = `${opts.userId || 'guest'}:${gameType}`;
  const revision = ++appearanceRevision;
  const mutationId = `${scope}:${revision}`;
  for (const field of APPEARANCE_FIELDS) {
    if (cleanPatch[field]) latestFieldRevision.set(`${scope}:${field}`, revision);
  }

  // 1. LIVE FIRST — mark the mutation before painting. Every table hook uses
  // this state to ignore an intermediate database echo from an older queued
  // write, while still allowing the optimistic event immediately following it.
  masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
    kind: 'table-appearance',
    scope,
    mutationId,
    state: 'pending',
  });
  // The felt must move on the same frame as the click, not
  //    after a network round trip. Every subscriber keys off this event.
  emitAppearance(gameType, cleanPatch, opts.userId, mutationId);

  if (!opts.userId) {
    const reverted: AppearancePatch = {};
    for (const field of APPEARANCE_FIELDS) {
      const previous = opts.previous?.[field];
      if (cleanPatch[field] && previous) reverted[field] = previous;
    }
    masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'table-appearance',
      scope,
      mutationId,
      state: 'rolling-back',
    });
    emitAppearance(gameType, reverted, opts.userId, mutationId);
    masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'table-appearance',
      scope,
      mutationId,
      state: 'rolled-back',
    });
    recordAppearanceResult('guest', startedAt, gameType, cleanPatch, opts.userId);
    return { ok: false, error: new Error('not signed in'), reverted };
  }

  /* Seed the durable baseline only at the start of a write chain. A later
     optimistic tap's `previous` may itself never persist; using it as a
     rollback target leaves phantom artwork behind when two requests fail.
     Successful queued writes advance this baseline below. */
  if ((pendingWriteCount.get(scope) ?? 0) === 0) {
    for (const field of APPEARANCE_FIELDS) {
      const previous = opts.previous?.[field];
      if (cleanPatch[field] && previous) durableFieldValue.set(`${scope}:${field}`, previous);
    }
  }
  pendingWriteCount.set(scope, (pendingWriteCount.get(scope) ?? 0) + 1);

  // 2. PERSIST IN TAP ORDER — only the changed columns plus the composite key.
  const previousTail = writeTails.get(scope) ?? Promise.resolve();
  const task = previousTail.then(() =>
    persistAppearancePatch(opts.userId as string, gameType, cleanPatch)
  );
  const tail = task.then(() => undefined);
  writeTails.set(scope, tail);
  const error = await task;
  if (writeTails.get(scope) === tail) writeTails.delete(scope);

  if (error) {
    // 3. PUT BACK ONLY FIELDS THIS MUTATION STILL OWNS. If a later tap is
    // already visible, an older failed request must never erase it.
    const reverted: AppearancePatch = {};
    for (const field of APPEARANCE_FIELDS) {
      const previous = durableFieldValue.get(`${scope}:${field}`) ?? opts.previous?.[field];
      if (
        cleanPatch[field] &&
        previous &&
        latestFieldRevision.get(`${scope}:${field}`) === revision
      ) {
        reverted[field] = previous;
      }
    }
    if (Object.keys(reverted).length < Object.keys(cleanPatch).length) {
      recordCustomizationOperation({
        userId: opts.userId,
        event: 'conflict_suppressed',
        surface: 'table-runtime',
        category: APPEARANCE_FIELDS.filter((field) => Boolean(cleanPatch[field])).join(':'),
        reasonCode: 'newer_optimistic_write',
      });
    }
    masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'table-appearance',
      scope,
      mutationId,
      state: 'rolling-back',
    });
    emitAppearance(gameType, reverted, opts.userId, mutationId);
    masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'table-appearance',
      scope,
      mutationId,
      state: 'rolled-back',
    });
    pendingWriteCount.set(scope, Math.max(0, (pendingWriteCount.get(scope) ?? 1) - 1));
    recordAppearanceResult('failed', startedAt, gameType, cleanPatch, opts.userId);
    return { ok: false, error, reverted };
  }

  for (const field of APPEARANCE_FIELDS) {
    const value = cleanPatch[field];
    if (value) durableFieldValue.set(`${scope}:${field}`, value);
  }
  pendingWriteCount.set(scope, Math.max(0, (pendingWriteCount.get(scope) ?? 1) - 1));
  masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
    kind: 'table-appearance',
    scope,
    mutationId,
    state: 'confirmed',
  });

  recordAppearanceResult('saved', startedAt, gameType, cleanPatch, opts.userId);
  return { ok: true };
}
