import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { signInUrl } from '../../lib/signIn';
import { IS_NATIVE_BUILD } from '../../lib/appBase';
import { useUserStore } from '../../stores/useUserStore';
import { getArenaContext } from '../../services/ArenaContextService';
import type { ArenaAccessContext } from '../../../server/src/domain/ArenaContext';
import PageSkeleton from '../common/PageSkeleton';
import {
  arenaAccessFailure,
  ARENA_ACCESS_FAILURE_COPY,
  type ArenaAccessFailure,
} from '../../services/arenaAccessFailure';
import DiamondCustodyBalance from './DiamondCustodyBalance';
import DiamondArenaWallet from './DiamondArenaWallet';
import { SpadeConsole } from '../console/SpadeConsole';
import { ArenaAccessProvider } from './arenaAccess';
import { isDiamondArenaLobbyPath, isDiamondArenaPlayerPath } from './diamondArenaRoutes';
import './DiamondArenaShell.css';

interface AccessState {
  key: string;
  accountGeneration: number;
  context: ArenaAccessContext | null;
  settled: boolean;
  failed: boolean;
  failure?: ArenaAccessFailure;
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
  /* THE PLAYER DOORS OPEN (2026-09-19). The lobby was the only route under
     the arena that rendered its page; Tournaments, Players, a member's own
     profile and Messages all fell to the safe shell below, so a Diamond
     player had the lobby and no way out of it. `isDiamondArenaPlayerPath`
     is the allowlist (src/components/arena/diamondArenaRoutes.ts): those
     routes render their page, and every operator, finance, agent and union
     route keeps the shell, which is what "no unions or agents" on a typed
     URL means. The closed-games notice stays on the lobby only. */
  const showArenaPlayerSurface = showCashLobby || isDiamondArenaPlayerPath(path);
  const showClosedNotice = showCashLobby || isDiamondArenaLobbyPath(path);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<AccessState>({
    key: '',
    accountGeneration: 0,
    context: null,
    settled: false,
    failed: false,
  });
  useEffect(() => {
    let alive = true;
    let request = 0;
    let accountId = useUserStore.getState().user?.id ?? null;
    let accountGeneration = 0;
    const refresh = async () => {
      const token = ++request;
      try {
        const context = key ? await getArenaContext(key) : null;
        if (alive && token === request)
          setState({ key, accountGeneration, context, settled: true, failed: false });
      } catch (error) {
        if (alive && token === request)
          setState({
            key,
            accountGeneration,
            context: null,
            settled: true,
            failed: true,
            failure: arenaAccessFailure(error),
          });
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
    } = supabase.auth.onAuthStateChange((event, session) => {
      const nextAccount = session?.user?.id ?? null;
      // Supabase also emits SIGNED_IN when the same account signs in in
      // another tab. Keep its verified page mounted during revalidation.
      // Actual identity transitions retire both pending reads and child drafts,
      // even if React batches A -> B -> A without an intermediate render.
      if (event === 'SIGNED_OUT' || nextAccount !== accountId) {
        accountId = nextAccount;
        ++accountGeneration;
        ++request;
        setState({
          key,
          accountGeneration,
          context: null,
          settled: event === 'SIGNED_OUT',
          failed: event === 'SIGNED_OUT',
          failure: event === 'SIGNED_OUT' ? 'authentication' : undefined,
        });
      }
      // Do not run Supabase calls synchronously inside the auth callback.
      const generation = accountGeneration;
      if (event !== 'SIGNED_OUT')
        queueMicrotask(() => {
          if (alive && generation === accountGeneration) void refresh();
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
          title="Access Not Verified"
          pill={ARENA_ACCESS_FAILURE_COPY[state.failure ?? 'service'].pill}
          pillInk="red"
          plates={{
            primary: {
              label: 'Retry',
              ink: 'white',
              onClick: () => {
                setState((value) => ({ ...value, settled: false }));
                setRetry((value) => value + 1);
              },
            },
            secondary: {
              label: state.failure === 'authentication' ? 'Sign In' : 'Back To Clubs',
              ink: 'white',
              onClick: () => {
                if (state.failure !== 'authentication') return navigate('/clubs');
                const url = signInUrl(path);
                if (IS_NATIVE_BUILD) navigate(url);
                else window.location.assign(url);
              },
            },
          }}
        >
          <p className="sc-copy">{ARENA_ACCESS_FAILURE_COPY[state.failure ?? 'service'].message}</p>
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
    return showArenaPlayerSurface ? (
      <ArenaAccessProvider key={`${key}:${state.accountGeneration}`} value={state.context}>
        {showClosedNotice && state.context.cashGamesEnabled !== true && (
          <p className="diamond-arena-notice">Diamond Games Are Not Open For Play Yet.</p>
        )}
        {children}
      </ArenaAccessProvider>
    ) : (
      <ArenaAccessProvider key={`${key}:${state.accountGeneration}`} value={state.context}>
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
  return (
    <ArenaAccessProvider key={`${key}:${state.accountGeneration}`} value={state.context}>
      {children}
    </ArenaAccessProvider>
  );
}
