/** An unreadable entitlement is neither a denial nor proof of an outage. */
export type ArenaAccessFailure = 'authentication' | 'timeout' | 'connection' | 'service';

export function arenaAccessFailure(error: unknown): ArenaAccessFailure {
  const value = error as { code?: string; message?: string; name?: string } | null;
  const code = value?.code ?? '';
  const message = value?.message ?? '';
  if (
    ['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code) ||
    /authentication required|jwt expired|invalid jwt|session.*expired/i.test(message)
  )
    return 'authentication';
  // PostgREST converts rejected browser fetches into an error object whose
  // message starts with the original name. ArenaContextService then creates
  // an Error, so the native AbortError name is no longer on that object.
  // A real server refusal keeps its SQL/PostgREST code and is not reclassified.
  const wrappedAbort = !code && /^AbortError:/.test(message);
  if (
    code === '57014' ||
    /timed? ?out|timeout/i.test(message) ||
    value?.name === 'AbortError' ||
    wrappedAbort
  )
    return 'timeout';
  if (/failed to fetch|fetch failed|network|load failed/i.test(message)) return 'connection';
  return 'service';
}

export const ARENA_ACCESS_FAILURE_COPY = {
  authentication: {
    pill: 'Sign In',
    message: 'Your Sign-In Could Not Be Verified. Please Sign In Again To Check Arena Access.',
  },
  timeout: {
    pill: 'Delayed',
    message:
      'The Access Check Took Too Long. We Could Not Confirm Your Arena Access. Please Retry.',
  },
  connection: {
    pill: 'Connection',
    message: 'The Access Service Could Not Be Reached. Check Your Connection And Retry.',
  },
  service: {
    pill: 'Unavailable',
    message: 'We Could Not Verify Arena Access. Please Retry. If This Continues, Contact Support.',
  },
} as const;
