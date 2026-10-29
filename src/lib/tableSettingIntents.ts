/** Unconfirmed choices survive a remount or reload; only their own save retires them. */
import { createMutationId } from './mutationId';

type Intent = { id: string; value: unknown };
const PREFIX = 'ca_table_setting_intent:';
const tails = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();

function key(userId: string, column: string): string {
  return `${PREFIX}${userId}:${column}`;
}

export function readTableSettingIntent(userId: string, column: string): Intent | null {
  try {
    const raw = localStorage.getItem(key(userId, column));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed &&
      typeof parsed.id === 'string' &&
      Object.prototype.hasOwnProperty.call(parsed, 'value')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function beginTableSettingIntent(userId: string, column: string, value: unknown): string {
  const id = createMutationId();
  revisions.set(userId, tableSettingRevision(userId) + 1);
  try {
    localStorage.setItem(key(userId, column), JSON.stringify({ id, value }));
  } catch {
    // Existing stores keep the in-memory selection when storage is unavailable.
  }
  return id;
}

export function confirmTableSettingIntent(userId: string, column: string, id: string): void {
  if (readTableSettingIntent(userId, column)?.id !== id) return;
  try {
    localStorage.removeItem(key(userId, column));
  } catch {
    // A retained intent is safe to send again through the original save path.
  }
}

export function tableSettingRevision(userId: string): number {
  return revisions.get(userId) ?? 0;
}

/** Shared across mounted hooks, so a slow earlier request cannot land last. */
export function orderTableSettingWrite<T>(
  userId: string,
  column: string,
  write: () => Promise<T>
): Promise<T> {
  const scope = key(userId, column);
  const previous = tails.get(scope);
  const task = previous ? previous.then(write, write) : write();
  tails.set(scope, task);
  void task.then(
    () => {
      if (tails.get(scope) === task) tails.delete(scope);
    },
    () => {
      if (tails.get(scope) === task) tails.delete(scope);
    }
  );
  return task;
}

/** A dropped connection cannot hold every later choice behind one hung save. */
export async function awaitPreferenceSave(
  request: PromiseLike<{ error: unknown }> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<{ error: unknown }>;
  }
): Promise<{ error: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation =
      typeof request.abortSignal === 'function' ? request.abortSignal(controller.signal) : request;
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<{ error: unknown }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            error: new Error('Preference save timed out; the selected value remains pending'),
          });
        }, 25_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
