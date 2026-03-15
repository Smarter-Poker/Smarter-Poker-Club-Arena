/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useSupabaseQuery — Declarative Data Fetching Hook
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reduces boilerplate for Supabase queries. Handles loading, error, and refetch.
 *
 * @example
 * const { data, loading, error, refetch } = useSupabaseQuery(
 *     () => supabase.from('clubs').select('*').eq('owner_id', userId),
 *     [userId]
 * );
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from './useIsMounted';

interface UseSupabaseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Declarative Supabase query hook.
 *
 * @param queryFn - Function that returns a Supabase query builder
 * @param deps - Dependency array (refetches when deps change)
 * @param options - Optional configuration
 */
export function useSupabaseQuery<T>(
  queryFn: () => Promise<{ data: T | null; error: { message: string } | null }>,
  deps: unknown[] = [],
  options?: { enabled?: boolean }
): UseSupabaseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const execute = useCallback(async () => {
    if (options?.enabled === false) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await queryFn();
      if (!isMounted.current) return;

      if (result.error) {
        setError(result.error.message);
        setData(null);
      } else {
        setData(result.data);
      }
    } catch (err) {
      if (!isMounted.current) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
      setData(null);
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  const refetch = useCallback(() => {
    execute();
  }, [execute]);

  return { data, loading, error, refetch };
}

export default useSupabaseQuery;
