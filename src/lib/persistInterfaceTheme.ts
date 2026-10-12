import type { InterfaceTheme as StoreInterfaceTheme } from '../stores/useSettingsStore';
import { createMutationId } from './mutationId';
import { supabase } from './supabase';

export type InterfaceTheme = StoreInterfaceTheme;

export interface PersistInterfaceThemeResult {
  ok: boolean;
  error?: unknown;
}

export const INTERFACE_THEME_WRITE_TIMEOUT_MS = 5_000;
const INTERFACE_THEME_WRITE_ATTEMPTS = 2;

class InterfaceThemeWriteTimeoutError extends Error {
  constructor() {
    super('Interface theme save timed out');
    this.name = 'InterfaceThemeWriteTimeoutError';
  }
}

type ThemeRpcResult = { data: unknown; error: unknown };
type AbortableThemeRequest = PromiseLike<ThemeRpcResult> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<ThemeRpcResult>;
};

function shouldRetryThemeWrite(error: unknown): boolean {
  if (error instanceof InterfaceThemeWriteTimeoutError) return true;
  if (!error || typeof error !== 'object') return true;
  const details = error as { code?: unknown; status?: unknown };
  const code = typeof details.code === 'string' ? details.code : '';
  if (['28000', '42501', '22023', 'P0002'].includes(code)) return false;
  const status = Number(details.status);
  return !Number.isFinite(status) || status < 400 || status >= 500;
}

async function callThemeWriter(
  userId: string,
  mutationId: string,
  theme: InterfaceTheme
): Promise<unknown | undefined> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let operation: PromiseLike<ThemeRpcResult>;
  try {
    const request = supabase.rpc('fn_set_interface_theme', {
      p_expected_user_id: userId,
      p_mutation_id: mutationId,
      p_theme: theme,
    }) as unknown as AbortableThemeRequest;
    operation =
      controller && typeof request.abortSignal === 'function'
        ? request.abortSignal(controller.signal)
        : request;
  } catch (error) {
    return error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(operation),
      new Promise<ThemeRpcResult>((resolve) => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve({ data: null, error: new InterfaceThemeWriteTimeoutError() });
        }, INTERFACE_THEME_WRITE_TIMEOUT_MS);
      }),
    ]);
    return result.error ?? undefined;
  } catch (error) {
    return error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Persist one interface-mode tap without replacing profiles.settings.
 * Requests are serialized per account, retain one mutation id across an
 * ambiguous retry, and carry the owner captured when the tap occurred.
 */
const writeTails = new Map<string, Promise<void>>();

export async function persistInterfaceTheme(
  userId: string,
  theme: InterfaceTheme
): Promise<PersistInterfaceThemeResult> {
  if (!userId) return { ok: false, error: new Error('not signed in') };

  const mutationId = createMutationId();
  const previousTail = writeTails.get(userId) ?? Promise.resolve();
  const task = previousTail.then(async (): Promise<unknown | undefined> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < INTERFACE_THEME_WRITE_ATTEMPTS; attempt += 1) {
      lastError = await callThemeWriter(userId, mutationId, theme);
      if (!lastError) return undefined;
      if (!shouldRetryThemeWrite(lastError)) return lastError;
    }
    return lastError;
  });

  const tail = task.then(() => undefined);
  writeTails.set(userId, tail);
  const error = await task;
  if (writeTails.get(userId) === tail) writeTails.delete(userId);

  return error ? { ok: false, error } : { ok: true };
}
