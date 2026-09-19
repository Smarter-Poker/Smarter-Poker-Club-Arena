import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { getArenaContext } from '../../services/ArenaContextService';
import type { ArenaAccessContext } from '../../../server/src/domain/ArenaContext';
import PageSkeleton from '../common/PageSkeleton';
import DiamondCustodyBalance from './DiamondCustodyBalance';
import DiamondArenaWallet from './DiamondArenaWallet';
import { SpadeConsole } from '../console/SpadeConsole';
import { ArenaAccessProvider } from './arenaAccess';
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
    /* ONE OPEN CLUB, THE SAME LOBBY (Dan 2026-09-11): "DIAMOND ARENA NEEDS TO
       BE A 1:1 CLONE OF THE CLUB ARENA. (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN
       CLUB' WITH NO UNIONS OR AGENTS AND ITS PLAYED WITH DIAMONDS INSTEAD OF
       CHIPS)".

       So the arena's own lobby route renders the SHARED lobby, exactly as a
       joined chip club does, rather than the placeholder panel this branch
       used to return. The operator routes underneath a club - finance, agents,
       operations, cashier - are chip-club surfaces with no Diamond meaning and
       stay on the safe shell below, which is what keeps "no unions or agents"
       true on a typed URL rather than only on a hidden link.

       The closed-games line stays above the lobby while `cash_games_enabled`
       is false. An empty game board is honest, but silently empty is not: the
       player is told why there is nothing to sit down at.

       THE ARENA HAS NO CHIP BRIDGE (2026-09-19). This notice used to carry the
       Diamonds To Chips button underneath it. That button leads to the host
       club's diamonds-to-chips wheel, which pays chip prizes into that club's
       `club_members.chip_balance`, and the programme's rule is that the arena
       club must never acquire chip balances. It was silent only because the
       Diamond host has no wheel configured; the day staff enabled one, every
       Diamond player would have been sent to it. The chip bridge is a chip
       club feature and is not mounted here. tests/the-diamond-arena-has-no-
       chip-bridge.law.test.ts holds this. */
    return showCashLobby ? (
      <ArenaAccessProvider value={state.context}>
        {state.context.cashGamesEnabled !== true && (
          <p className="diamond-arena-notice">Diamond Games Are Not Open For Play Yet.</p>
        )}
        {children}
      </ArenaAccessProvider>
    ) : (
      <ArenaAccessProvider value={state.context}>
        <section className="club-home diamond-arena-shell" aria-label="Diamond Arena">
          <SpadeConsole
            eyebrow="Welcome To"
            title="Diamond Arena"
            crest="diamond"
            pill={state.context.cashGamesEnabled === true ? 'Open' : 'Soon'}
            pillInk={state.context.cashGamesEnabled === true ? 'green' : 'gold'}
          >
            <p className="sc-copy">You Are Already A Member.</p>
            {state.context.cashGamesEnabled !== true && (
              <p className="sc-copy">Diamond Games Are Not Open For Play Yet.</p>
            )}
          </SpadeConsole>
          <DiamondCustodyBalance />
          <DiamondArenaWallet />
        </section>
      </ArenaAccessProvider>
    );
  if (!state.context.member && redirectToJoin)
    return <Navigate to={`/invite/${encodeURIComponent(key)}`} replace />;
  if (!state.context.member)
    return (
      <section className="club-home error">
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
  return <ArenaAccessProvider value={state.context}>{children}</ArenaAccessProvider>;
}
