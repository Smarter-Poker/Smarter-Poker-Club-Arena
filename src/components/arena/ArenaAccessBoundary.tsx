import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getArenaContext } from '../../services/ArenaContextService';
import type { ArenaAccessContext } from '../../../server/src/domain/ArenaContext';
import PageSkeleton from '../common/PageSkeleton';

interface AccessState {
  key: string;
  context: ArenaAccessContext | null;
  settled: boolean;
  failed: boolean;
}

/** Checks entry before cached chip content can mount. This never navigates the host table. */
export default function ArenaAccessBoundary({
  clubKey,
  children,
}: {
  clubKey?: string;
  children: ReactNode;
}) {
  const key = clubKey?.trim() || '';
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<AccessState>({
    key: '',
    context: null,
    settled: false,
    failed: false,
  });
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refresh = async () => {
      const token = ++request;
      try {
        const context = key ? await getArenaContext(key) : null;
        if (alive && token === request) setState({ key, context, settled: true, failed: false });
      } catch {
        if (alive && token === request)
          setState({ key, context: null, settled: true, failed: true });
      }
    };
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
        ++request;
        setState({
          key,
          context: null,
          settled: event === 'SIGNED_OUT',
          failed: event === 'SIGNED_OUT',
        });
      }
      // Do not run Supabase calls synchronously inside the auth callback.
      if (event !== 'SIGNED_OUT')
        queueMicrotask(() => {
          if (alive) void refresh();
        });
    });
    return () => {
      alive = false;
      ++request;
      subscription.unsubscribe();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, retry]);

  if (state.key !== key || !state.settled) return <PageSkeleton />;
  if (state.failed && !state.context)
    return (
      <section className="club-home error" role="alert">
        <h2>Could Not Verify Arena Access</h2>
        <button className="btn btn-primary" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </button>
      </section>
    );
  if (!state.context)
    return (
      <section className="club-home error">
        <h2>Arena Not Found</h2>
      </section>
    );
  if (state.context.automaticMembership)
    return (
      <section className="club-home" aria-label="Diamond Arena">
        <h2>Diamond Arena</h2>
        <p>You Are Already A Member.</p>
        <p>Diamond Games Are Not Open For Play Yet.</p>
      </section>
    );
  if (!state.context.member)
    return (
      <section className="club-home error">
        <h2>Join This Club To Enter</h2>
        <Link className="btn btn-primary" to={`/invite/${encodeURIComponent(key)}`}>
          Join This Club
        </Link>
      </section>
    );
  return <>{children}</>;
}
