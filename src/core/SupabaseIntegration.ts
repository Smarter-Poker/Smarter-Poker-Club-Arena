/** Supabase diagnostics remain local and preserve every result and rejection. */
import { reportError, reportWarning } from '../utils/errorReporter';

export async function trackSupabaseOperation<T>(
  table: string,
  operation: string,
  promise: Promise<T>
): Promise<T> {
  try {
    const result = await promise;
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      const error = result.error as { code?: string };
      reportError(error, `Supabase.${table}.${operation}`);
      if (error.code === 'PGRST301' || error.code === '42501') {
        reportWarning('RLS Policy Violation', `Supabase.${table}.${operation}`, {
          code: error.code,
        });
      }
    }
    return result;
  } catch (error) {
    reportError(error, `Supabase.${table}.${operation}`);
    throw error;
  }
}

export async function trackSupabaseQuery<T>(
  table: string,
  operation: string,
  query: PromiseLike<T>
): Promise<T> {
  return trackSupabaseOperation(table, operation, Promise.resolve(query));
}
