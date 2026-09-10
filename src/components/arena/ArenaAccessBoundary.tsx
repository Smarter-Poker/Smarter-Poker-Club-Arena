import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getArenaContext } from '../../services/ArenaContextService';
import type { ArenaAccessContext } from '../../../server/src/domain/ArenaContext';
import PageSkeleton from '../common/PageSkeleton';
import DiamondCustodyBalance from './DiamondCustodyBalance';
import DiamondArenaWallet from './DiamondArenaWallet';
import PokerArenaNavigation from './PokerArenaNavigation';
import DiamondCashLobby from './DiamondCashLobby';
import { SpadeConsole } from '../console/SpadeConsole';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
import './DiamondArenaShell.css';

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
  redirectToJoin = false,
  cashLobby = false,
}: {
  clubKey?: string;
  children: ReactNode;
  redirectToJoin?: boolean;
  cashLobby?: boolean;
}) {
  const key = clubKey?.trim() || '';
  const path = useLocation().pathname;
  const navigate = useNavigate();
  const showCashLobby = cashLobby || /\/clubs\/[^/]+\/?$/.test(path);
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
        <SpadeConsole
          eyebrow="Poker Arena"
          title="Could Not Verify Arena Access"
          pill="Offline"
          pillInk="red"
          plates={{
            primary: {
              label: 'Retry',
              ink: 'white',
              onClick: () => setRetry((value) => value + 1),
            },
          }}
        >
          <p className="sc-copy">
            The Arena Did Not Answer. Nothing Is Wrong With Your Account; The Check Simply Did Not
            Come Back. Try Again In A Moment.
          </p>
        </SpadeConsole>
      </section>
    );
  if (!state.context)
    return (
      <section className="club-home error">
        <SpadeConsole eyebrow="Poker Arena" title="Arena Not Found" pill="Closed" pillInk="red">
          <p className="sc-copy">That Link Does Not Lead To A Club On This Platform Any More.</p>
        </SpadeConsole>
      </section>
    );
  if (state.context.automaticMembership)
    return (
      <section className="club-home diamond-arena-shell" aria-label="Diamond Arena">
        <PokerArenaNavigation />
        <SpadeConsole
          eyebrow="Welcome To"
          title="Diamond Arena"
          crest="diamond"
          pill={state.context.cashGamesEnabled === true ? 'Open' : 'Soon'}
          pillInk={state.context.cashGamesEnabled === true ? 'green' : 'gold'}
        >
          <p className="sc-copy">You Are Already A Member.</p>
          {state.context.cashGamesEnabled !== true && (
            <>
              <p className="sc-copy">Diamond Games Are Not Open For Play Yet.</p>
              <DiamondsToChipsButton
                clubId={key || null}
                size="compact"
                onGo={(to) => navigate(to)}
              />
            </>
          )}
        </SpadeConsole>
        {state.context.cashGamesEnabled === true && showCashLobby && (
          <DiamondCashLobby key={state.context.arena.id} arenaId={state.context.arena.id} />
        )}
        <DiamondCustodyBalance />
        <DiamondArenaWallet />
      </section>
    );
  if (!state.context.member && redirectToJoin)
    return <Navigate to={`/invite/${encodeURIComponent(key)}`} replace />;
  if (!state.context.member)
    return (
      <section className="club-home error">
        <PokerArenaNavigation />
        <SpadeConsole
          eyebrow="Poker Arena"
          title="Join This Club To Enter"
          pill="Members"
          pillInk="blue"
          plates={{
            primary: {
              label: 'Join This Club',
              ink: 'white',
              onClick: () => navigate(`/invite/${encodeURIComponent(key)}`),
            },
          }}
        >
          <p className="sc-copy">
            This Club's Tables, Tournaments And Diamond Games Are Open To Its Members. Joining Takes
            One Tap.
          </p>
        </SpadeConsole>
      </section>
    );
  return (
    <>
      <PokerArenaNavigation />
      {children}
    </>
  );
}
