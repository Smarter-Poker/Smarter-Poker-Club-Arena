import { supabase } from './supabase';
import type { InterfaceTheme } from '../stores/useSettingsStore';
import { createMutationId } from './mutationId';

export const ACCOUNT_SETTINGS_WRITE_TIMEOUT_MS = 8_000;
const ACCOUNT_SETTINGS_WRITE_ATTEMPTS = 2;

export type PersistAccountSettingsResult = { ok: true } | { ok: false; error: unknown };

class AccountSettingsWriteTimeoutError extends Error {
  constructor() {
    super('Account settings save timed out');
    this.name = 'AccountSettingsWriteTimeoutError';
  }
}

type RpcResult = { data: unknown; error: unknown };
type AbortableRpc = PromiseLike<RpcResult> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResult>;
};

const accountWriteTails = new Map<string, Promise<void>>();

function isRetryable(error: unknown): boolean {
  if (error instanceof AccountSettingsWriteTimeoutError) return true;
  if (!error || typeof error !== 'object') return true;
  const details = error as { code?: unknown; status?: unknown };
  const code = typeof details.code === 'string' ? details.code : '';
  if (['28000', '42501', '22023', 'P0002'].includes(code)) return false;
  const status = Number(details.status);
  return !Number.isFinite(status) || status < 400 || status >= 500;
}

async function attemptSave(
  userId: string,
  mutationId: string,
  settingsPatch: Record<string, unknown>,
  interfaceTheme: InterfaceTheme
): Promise<unknown | undefined> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let operation: PromiseLike<RpcResult>;
  try {
    const request = supabase.rpc('fn_patch_account_settings', {
      p_expected_user_id: userId,
      p_mutation_id: mutationId,
      p_settings_patch: settingsPatch,
      p_interface_theme: interfaceTheme,
    }) as unknown as AbortableRpc;
    operation =
      controller && typeof request.abortSignal === 'function'
        ? request.abortSignal(controller.signal)
        : request;
  } catch (error) {
    // Normalize synchronous adapters so this account's serialized tail drains.
    return error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve(operation),
      new Promise<RpcResult>((resolve) => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve({ data: null, error: new AccountSettingsWriteTimeoutError() });
        }, ACCOUNT_SETTINGS_WRITE_TIMEOUT_MS);
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
 * Merge a Settings-page patch without replacing profiles.settings. Repeating
 * the same merge after an ambiguous transport timeout is idempotent, and the
 * expected owner prevents a deferred request from crossing an auth switch.
 */
export async function persistAccountSettings(
  userId: string,
  settingsPatch: Record<string, unknown>,
  interfaceTheme: InterfaceTheme
): Promise<PersistAccountSettingsResult> {
  if (!userId) return { ok: false, error: new Error('Authentication required') };

  const mutationId = createMutationId();
  const previousTail = accountWriteTails.get(userId) ?? Promise.resolve();
  const task = previousTail.then(async (): Promise<unknown | undefined> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < ACCOUNT_SETTINGS_WRITE_ATTEMPTS; attempt += 1) {
      lastError = await attemptSave(userId, mutationId, settingsPatch, interfaceTheme);
      if (!lastError) return undefined;
      if (!isRetryable(lastError)) return lastError;
    }
    return lastError;
  });
  const tail = task.then(() => undefined);
  accountWriteTails.set(userId, tail);
  const error = await task;
  if (accountWriteTails.get(userId) === tail) accountWriteTails.delete(userId);
  return error ? { ok: false, error } : { ok: true };
}
