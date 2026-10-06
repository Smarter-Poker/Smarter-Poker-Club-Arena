import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { SpadeConsole } from '../console/SpadeConsole';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { isAuthzError } from '../../utils/clubDashboard';
import { useVisibilityRefresh } from '../../hooks/useVisibilityRefresh';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { clubGamesOrFilter } from '../../utils/unionScope';
import { resolveClubUUIDStrict } from '../../utils/strictClubIdResolver';
import { isUUID } from '../../utils/clubIdResolver';
import { compactChips } from '../../utils/format';
import {
  parseClubFinancialsPayload,
  type FinancialsPayload,
} from '../../utils/clubFinancialsPayload';
import './ClubFinancialDashboard.css';

interface FinancialDashboardProps {
  clubId: string;
  canManageAgents: boolean;
  initialSnapshot?: {
    resolvedClubId: string;
    requestedStart: string;
    requestedEnd: string;
    financials: FinancialsPayload;
  };
}

interface DashboardReading {
  resolvedClubId: string;
  diamondBalance: number;
  activeTableCount: number;
  financials: FinancialsPayload;
}

interface DashboardState {
  scope: string;
  status: 'loading' | 'ready' | 'error' | 'denied';
  reading: DashboardReading | null;
}

function sevenDayWindow(): { start: string; end: string } {
  const endDate = new Date();
  const end = endDate.toISOString().slice(0, 10);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end };
}

function countValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} Could Not Be Verified`);
  }
  return value;
}

function diamondBalanceValue(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diamond Vault Could Not Be Verified');
  }
  return countValue((value as { balance?: unknown }).balance, 'Diamond Vault');
}

function dayLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export const ClubFinancialDashboard = ({
  clubId,
  canManageAgents,
  initialSnapshot,
}: FinancialDashboardProps) => {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const currentScopeRef = useRef(clubId);
  const readRequestRef = useRef(0);
  currentScopeRef.current = clubId;

  const [state, setState] = useState<DashboardState>({
    scope: clubId,
    status: 'loading',
    reading: null,
  });
  const refreshDashboard = useCallback(async () => {
    const requestScope = clubId;
    const requestId = ++readRequestRef.current;
    const isCurrent = () =>
      isMounted.current &&
      currentScopeRef.current === requestScope &&
      readRequestRef.current === requestId;

    setState({ scope: requestScope, status: 'loading', reading: null });
    try {
      const { start, end } = sevenDayWindow();
      const snapshot = initialSnapshot;
      const canReuseSnapshot =
        snapshot !== undefined &&
        isUUID(snapshot.resolvedClubId) &&
        snapshot.requestedStart === start &&
        snapshot.requestedEnd === end &&
        snapshot.financials.range.end === end &&
        snapshot.financials.range.start >= start;
      const resolvedClubId =
        canReuseSnapshot && snapshot
          ? snapshot.resolvedClubId
          : await resolveClubUUIDStrict(requestScope);
      const gamesFilter = await clubGamesOrFilter(resolvedClubId);
      const [diamondResult, tablesResult] = await Promise.all([
        supabase
          .from('club_diamond_wallets')
          .select('balance')
          .eq('club_id', resolvedClubId)
          .maybeSingle(),
        supabase
          .from('tables')
          .select('id', { count: 'exact', head: true })
          .or(gamesFilter)
          .eq('status', 'active'),
      ]);

      const error = diamondResult.error || tablesResult.error;
      if (error) {
        if (isAuthzError(error)) {
          if (isCurrent()) {
            setState({ scope: requestScope, status: 'denied', reading: null });
          }
          return;
        }
        throw error;
      }

      let financials: FinancialsPayload;
      if (canReuseSnapshot && snapshot) {
        financials = parseClubFinancialsPayload(snapshot.financials, {
          clubId: snapshot.resolvedClubId,
          start,
          end,
        });
      } else {
        const { data: payload, error: financialError } = await supabase.rpc('ca_club_financials', {
          p_club_id: resolvedClubId,
          p_start: start,
          p_end: end,
        });
        if (financialError) {
          if (isAuthzError(financialError)) {
            if (isCurrent()) {
              setState({ scope: requestScope, status: 'denied', reading: null });
            }
            return;
          }
          throw financialError;
        }
        financials = parseClubFinancialsPayload(payload, { clubId: resolvedClubId, start, end });
      }

      const reading: DashboardReading = {
        resolvedClubId,
        diamondBalance: diamondBalanceValue(diamondResult.data),
        activeTableCount: countValue(tablesResult.count, 'Active Table Count'),
        financials,
      };
      if (!isCurrent()) return;
      setState({ scope: requestScope, status: 'ready', reading });
    } catch (error) {
      reportError(error, 'ClubFinancialDashboard.read');
      if (isCurrent()) {
        setState({ scope: requestScope, status: 'error', reading: null });
      }
    }
  }, [clubId, initialSnapshot, isMounted]);

  useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard]);

  useVisibilityRefresh(refreshDashboard);

  const realtimeClubId =
    state.scope === clubId && state.status === 'ready' ? state.reading?.resolvedClubId : null;

  useEffect(() => {
    if (!realtimeClubId) return;
    const channelKey = `club-financial-dashboard:${realtimeClubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_diamond_wallets',
          filter: `club_id=eq.${realtimeClubId}`,
        },
        () => void refreshDashboard()
      )
      .subscribe((status: string, error?: Error) => {
        if (status === 'CHANNEL_ERROR' && error) {
          reportError(error, 'ClubFinancialDashboard.realtime');
        }
        if (status === 'TIMED_OUT') {
          reportError(new Error('Financial Realtime Timed Out'), 'ClubFinancialDashboard.realtime');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [realtimeClubId, refreshDashboard]);

  const activeState: DashboardState =
    state.scope === clubId ? state : { scope: clubId, status: 'loading', reading: null };
  const reading = activeState.status === 'ready' ? activeState.reading : null;

  const chartData = useMemo(
    () =>
      reading?.financials.daily.map((row) => ({
        day: dayLabel(row.d),
        grossRake: row.gross_rake,
        hands: row.raked_hands,
      })) ?? [],
    [reading]
  );

  if (activeState.status === 'loading') {
    return (
      <div className="cfd">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Financials"
          title="Club Financial Command"
          pill="Reading"
          pillInk="gold"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="status">
            Verifying The Club Financial Reading
          </p>
        </SpadeConsole>
      </div>
    );
  }

  if (activeState.status === 'denied') {
    return (
      <div className="cfd">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Financials"
          title="Club Financial Command"
          pill="Restricted"
          pillInk="red"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center" role="alert">
            Financial Access Could Not Be Verified For This Club.
          </p>
        </SpadeConsole>
      </div>
    );
  }

  if (!reading) {
    return (
      <div className="cfd">
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Club Financials"
          title="Club Financial Command"
          pill="Unavailable"
          pillInk="red"
          plates={{
            secondary: { label: 'Back', onClick: () => navigate(-1) },
            primary: { label: 'Try Again', onClick: () => void refreshDashboard() },
          }}
        >
          <p className="sc-copy sc-copy--center" role="alert">
            The Financial Reading Could Not Be Verified. No Zero Or All Clear Is Being Shown.
          </p>
        </SpadeConsole>
      </div>
    );
  }

  const totals = reading.financials.totals;

  return (
    <div className="cfd">
      <SpadeConsole
        family="spade"
        crest="spade"
        eyebrow="Club Financials"
        title="Club Financial Command"
        pill="Verified"
        pillInk="blue"
        foot="foot"
      >
        <dl className="cfd__facts" aria-label="Verified Club Financial Summary">
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Diamond Vault</dt>
            <dd className="sc-ink--silver">{compactChips(reading.diamondBalance)}</dd>
          </div>
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Seven Day Gross Rake</dt>
            <dd className="sc-ink--silver">{compactChips(totals.gross_rake)}</dd>
          </div>
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Seven Day Net Revenue</dt>
            <dd className={totals.net_revenue < 0 ? 'sc-ink--red' : 'sc-ink--silver'}>
              {compactChips(totals.net_revenue)}
            </dd>
          </div>
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Agent Commissions Paid</dt>
            <dd className="sc-ink--silver">{compactChips(totals.agent_commissions)}</dd>
          </div>
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Player Rakeback Paid</dt>
            <dd className="sc-ink--silver">{compactChips(totals.rakeback_paid)}</dd>
          </div>
          <div className="cfd__fact">
            <dt className="sc-label sc-ink--blue">Active Tables</dt>
            <dd className="sc-ink--silver">{compactChips(reading.activeTableCount)}</dd>
          </div>
        </dl>

        <div className="cfd__charts">
          <section className="cfd__chart" aria-labelledby="cfd-rake-chart">
            <h3 id="cfd-rake-chart" className="sc-label sc-ink--silver">
              Gross Rake Trend
            </h3>
            <ResponsiveContainer
              width="100%"
              height={190}
              initialDimension={{ width: 280, height: 190 }}
            >
              <AreaChart data={chartData} margin={{ top: 12, right: 4, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#9aa5b3" strokeOpacity={0.14} vertical={false} />
                <XAxis
                  dataKey="day"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#9aa5b3', fontSize: 10 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#9aa5b3', fontSize: 10 }}
                  tickFormatter={(value) => compactChips(Number(value))}
                />
                <Area
                  type="monotone"
                  dataKey="grossRake"
                  stroke="#45adff"
                  strokeWidth={3}
                  fill="#1877f2"
                  fillOpacity={0.22}
                  isAnimationActive
                />
              </AreaChart>
            </ResponsiveContainer>
          </section>

          <section className="cfd__chart" aria-labelledby="cfd-hands-chart">
            <h3 id="cfd-hands-chart" className="sc-label sc-ink--silver">
              Raked Hands Trend
            </h3>
            <ResponsiveContainer
              width="100%"
              height={190}
              initialDimension={{ width: 280, height: 190 }}
            >
              <BarChart data={chartData} margin={{ top: 12, right: 4, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#9aa5b3" strokeOpacity={0.14} vertical={false} />
                <XAxis
                  dataKey="day"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#9aa5b3', fontSize: 10 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#9aa5b3', fontSize: 10 }}
                  tickFormatter={(value) => compactChips(Number(value))}
                />
                <Bar dataKey="hands" fill="#e4e7ec" isAnimationActive />
              </BarChart>
            </ResponsiveContainer>
          </section>
        </div>
      </SpadeConsole>

      {reading.financials.union_id ? (
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Union Treasury"
          title="Treasury Funding"
          pill="Union Funded"
          pillInk="gold"
          foot="foot"
        >
          <dl className="cfd__facts">
            <div className="cfd__fact">
              <dt className="sc-label sc-ink--blue">Funding Authority</dt>
              <dd className="sc-ink--silver">Union Treasury</dd>
            </div>
            <div className="cfd__fact">
              <dt className="sc-label sc-ink--blue">Local Minting</dt>
              <dd className="sc-ink--gold">Managed By The Union</dd>
            </div>
          </dl>
          <p className="sc-copy sc-copy--center">
            Minting Is Managed By The Union Treasury For This Club.
          </p>
          <button
            type="button"
            className="cfd__word-action"
            onClick={() => navigate(`/clubs/${encodeURIComponent(clubId)}/cashier`)}
          >
            Open Club Bank Cashier
          </button>
        </SpadeConsole>
      ) : (
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Server Guarded"
          title="Club Bank Cashier"
          pill="Maintained Flow"
          pillInk="blue"
          foot="foot"
        >
          <dl className="cfd__facts">
            <div className="cfd__fact">
              <dt className="sc-label sc-ink--blue">Mint Destination</dt>
              <dd className="sc-ink--silver">Club Bank</dd>
            </div>
            <div className="cfd__fact">
              <dt className="sc-label sc-ink--blue">Diamond Cost</dt>
              <dd className="sc-ink--silver">Shown Before Confirmation</dd>
            </div>
            <div className="cfd__fact">
              <dt className="sc-label sc-ink--blue">Financial Receipt</dt>
              <dd className="sc-ink--silver">Server Verified</dd>
            </div>
          </dl>
          <p className="sc-copy sc-copy--center">
            Review The Destination, Diamond Cost, And Durable Receipt In The Club Bank Cashier.
          </p>
          <button
            type="button"
            className="cfd__word-action"
            onClick={() => navigate(`/clubs/${encodeURIComponent(clubId)}/cashier`)}
          >
            Open Club Bank Cashier
          </button>
        </SpadeConsole>
      )}

      {canManageAgents ? (
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Selected Club"
          title="Agent Management"
          pill="Club Control"
          pillInk="blue"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center">
            Review Named Agents And Manage Their Selected Club Permissions In Agent Management.
          </p>
          <button
            type="button"
            className="cfd__word-action"
            onClick={() => navigate(`/clubs/${encodeURIComponent(clubId)}/agents`)}
          >
            Open Agent Management
          </button>
        </SpadeConsole>
      ) : (
        <SpadeConsole
          family="spade"
          crest="spade"
          eyebrow="Selected Club"
          title="Agent Network"
          pill="Your Network"
          pillInk="blue"
          foot="foot"
        >
          <p className="sc-copy sc-copy--center">
            Review Your Selected Club Agent Network, Players, And Activity.
          </p>
          <button
            type="button"
            className="cfd__word-action"
            onClick={() => navigate(`/clubs/${encodeURIComponent(clubId)}/agent-dashboard`)}
          >
            Open Agent Network
          </button>
        </SpadeConsole>
      )}

      <SpadeConsole
        family="spade"
        crest="spade"
        eyebrow="Selected Club"
        title="Club Disputes"
        pill="Club Scope"
        pillInk="blue"
        foot="foot"
      >
        <p className="sc-copy sc-copy--center">Open The Selected Club Dispute Queue.</p>
        <button
          type="button"
          className="cfd__word-action"
          onClick={() => navigate(`/clubs/${encodeURIComponent(clubId)}/disputes`)}
        >
          Open Disputes
        </button>
      </SpadeConsole>
    </div>
  );
};

export default ClubFinancialDashboard;
