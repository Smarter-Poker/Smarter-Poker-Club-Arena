import { supabase } from '../lib/supabase';
import { isUUID, resolveClubIdFilter, resolveClubUUIDSync } from './clubIdResolver';
import { reportError } from './errorReporter';
import { runRosterReadWithRetry } from './rosterReadReliability';

export class ClubNotFoundError extends Error {
  constructor(clubIdParam: string) {
    super(`Club "${clubIdParam}" was not found.`);
    this.name = 'ClubNotFoundError';
  }
}

export class ClubResolutionError extends Error {
  readonly cause: unknown;

  constructor(clubIdParam: string, cause: unknown) {
    super(`Club identity could not be resolved for "${clubIdParam}".`);
    this.name = 'ClubResolutionError';
    this.cause = cause;
  }
}

/**
 * Network-only half of strict club resolution. Kept behind a dynamic import so
 * route retry machinery is downloaded only when an uncached alias needs it.
 */
export async function resolveClubUUIDStrict(clubIdParam: string): Promise<string> {
  if (isUUID(clubIdParam)) return clubIdParam;
  const cached = resolveClubUUIDSync(clubIdParam);
  if (cached) return cached;
  const filter = resolveClubIdFilter(clubIdParam);
  let data: { id: string } | null;

  try {
    data = await runRosterReadWithRetry(
      async (signal) => {
        let request = supabase
          .from('clubs')
          .select('id')
          .eq(filter.column, filter.value)
          .maybeSingle();
        if (typeof (request as any).abortSignal === 'function') {
          request = (request as any).abortSignal(signal);
        }
        const result = await request;
        if (result.error) throw result.error;
        return result.data as { id: string } | null;
      },
      { attempts: 3, timeoutMs: 8_000 }
    );
  } catch (error) {
    reportError(error, 'clubIdResolver.resolveClubUUIDStrict', { clubIdParam });
    throw new ClubResolutionError(clubIdParam, error);
  }

  if (!data?.id || !isUUID(data.id)) throw new ClubNotFoundError(clubIdParam);
  return data.id;
}
