import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface SystemHealth {
  status: 'ok' | 'degraded';
  supabase: 'ok' | 'error';
  latencyMs: number;
  timestamp: string;
  version: string;
}

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [requestId, setRequestId] = useState(0);

  const retry = useCallback(() => setRequestId((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    const start = performance.now();
    setIsChecking(true);

    void (async () => {
      let supabaseStatus: SystemHealth['supabase'] = 'error';
      try {
        const { error } = await supabase
          .from('settlement_periods')
          .select('id', { count: 'exact', head: true })
          .limit(1);
        if (!error) supabaseStatus = 'ok';
      } catch (error) {
        reportError(error, 'useSystemHealth.check');
      }

      if (cancelled) return;
      setHealth({
        status: supabaseStatus === 'ok' ? 'ok' : 'degraded',
        supabase: supabaseStatus,
        latencyMs: Math.round(performance.now() - start),
        timestamp: new Date().toISOString(),
        version: import.meta.env.VITE_APP_VERSION || '1.0.0',
      });
      setIsChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  return { health, isChecking, retry };
}
