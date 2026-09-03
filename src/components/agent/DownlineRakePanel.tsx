/**
 * DOWNLINE RAKE — live.
 *
 * What an agent sees: every member beneath them, the rake each has generated
 * in the selected window, and what that is worth to them at their commission
 * rate. Updates as hands are played.
 *
 * Drill-down: any member who is themselves an agent can be opened to show
 * THEIR downline, following the chain as deep as it goes. The breadcrumb walks
 * back up. The database re-checks ancestry on every call, so drilling is
 * limited to people genuinely beneath the viewer.
 *
 * Plain players never reach this component — but if one did, the RPC refuses
 * with `not_an_agent` and that is what gets shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentRakeService,
  RAKE_WINDOWS,
  windowToRange,
  describeRakeError,
  type AgentRoleRow,
  type DownlineRakeRow,
  type DownlineRakeSummary,
  type RakeWindowKey,
} from '../../services/AgentRakeService';
import { reportError } from '../../utils/errorReporter';

const money = (n: unknown) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const count = (n: unknown) => new Intl.NumberFormat('en-US').format(Number(n) || 0);

const AGENT_ROLES = new Set(['super_agent', 'agent', 'sub_agent']);

type Crumb = { userId: string; name: string };

export default function DownlineRakePanel({ roles }: { roles: AgentRoleRow[] }) {
  const [clubId, setClubId] = useState<string>(roles[0]?.club_id ?? '');
  const [win, setWin] = useState<RakeWindowKey>('week');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<DownlineRakeRow[]>([]);
  const [summary, setSummary] = useState<DownlineRakeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [liveAt, setLiveAt] = useState<Date | null>(null);

  const inFlight = useRef(false);
  const pending = useRef(false);

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const focusUserId = crumbs.length ? crumbs[crumbs.length - 1].userId : undefined;

  const load = useCallback(
    async (quiet = false) => {
      // Coalesce: a burst of live events must not stack up requests.
      if (inFlight.current) {
        pending.current = true;
        return;
      }
      inFlight.current = true;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const { since, until } = windowToRange(win);
        const args = {
          agentUserId: focusUserId,
          clubId: clubId || undefined,
          since,
          until,
        };
        const [r, s] = await Promise.all([
          AgentRakeService.getDownlineRake({ ...args, search: debounced, limit: 500 }),
          AgentRakeService.getDownlineRakeSummary(args),
        ]);
        setRows(r);
        setSummary(s);
        setLiveAt(new Date());
      } catch (e) {
        setError(describeRakeError(e));
        reportError(e, 'DownlineRakePanel.load');
      } finally {
        inFlight.current = false;
        setLoading(false);
        if (pending.current) {
          pending.current = false;
          void load(true);
        }
      }
    },
    [clubId, win, debounced, focusUserId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Live: refresh when commission is written (i.e. rake was earned), and poll
  // as a fallback in case the socket drops. Both are quiet refreshes so the
  // table never flashes a spinner while someone is reading it.
  useEffect(() => {
    let debounceTimer: number | undefined;

    const bump = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void load(true), 2500);
    };

    const unsub = AgentRakeService.subscribeToRake(clubId || undefined, bump);
    const timer = window.setInterval(() => void load(true), 30_000);

    return () => {
      unsub();
      window.clearTimeout(debounceTimer);
      window.clearInterval(timer);
    };
  }, [clubId, load]);

  const totals = useMemo(() => {
    const shown = rows.reduce((s, r) => s + Number(r.rake_generated || 0), 0);
    return { shown };
  }, [rows]);

  const drillInto = (r: DownlineRakeRow) => {
    if (!AGENT_ROLES.has(r.role)) return;
    setCrumbs((c) => [...c, { userId: r.player_id, name: r.username ?? 'agent' }]);
    setSearch('');
  };

  const popTo = (i: number) => setCrumbs((c) => c.slice(0, i));

  const pill = (active: boolean) => ({
    padding: '6px 12px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    border: active ? '1px solid #37e7c7' : '1px solid #2a3a44',
    background: active ? 'rgba(55,231,199,0.12)' : 'transparent',
    color: active ? '#37e7c7' : '#8fa3ad',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 20px' }}>
      {/* CONTROLS */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {roles.length > 1 && (
          <select
            value={clubId}
            onChange={(e) => {
              setClubId(e.target.value);
              setCrumbs([]);
            }}
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid #2a3a44',
              background: 'rgba(255,255,255,0.04)',
              color: '#e6f1f5',
              fontSize: '0.82rem',
            }}
          >
            {roles.map((r) => (
              <option key={r.club_id} value={r.club_id}>
                {r.club_name} · {r.role.replace('_', ' ')}
              </option>
            ))}
          </select>
        )}
        {RAKE_WINDOWS.map((w) => (
          <button key={w.key} onClick={() => setWin(w.key)} style={pill(win === w.key)}>
            {w.label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search A Player…"
          style={{
            flex: '1 1 180px',
            minWidth: 140,
            padding: '7px 12px',
            borderRadius: 8,
            border: '1px solid #2a3a44',
            background: 'rgba(255,255,255,0.04)',
            color: '#e6f1f5',
            fontSize: '0.82rem',
          }}
        />
      </div>

      {/* BREADCRUMB */}
      {crumbs.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: '0.82rem',
          }}
        >
          <button
            onClick={() => popTo(0)}
            style={{
              background: 'none',
              border: 'none',
              color: '#37e7c7',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            My Downline
          </button>
          {crumbs.map((c, i) => (
            <span key={c.userId} style={{ color: '#66787f' }}>
              {' › '}
              <button
                onClick={() => popTo(i + 1)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  color: i === crumbs.length - 1 ? '#e6f1f5' : '#37e7c7',
                  fontWeight: i === crumbs.length - 1 ? 700 : 400,
                }}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {error ? (
        <div
          style={{
            padding: 14,
            borderRadius: 10,
            border: '1px solid #5a2020',
            background: 'rgba(255,118,118,0.08)',
            color: '#ff9c9c',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => void load()}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid #5a2020',
              background: 'transparent',
              color: '#ff9c9c',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div style={{ color: '#8aa', padding: 12 }}>Loading Downline Rake…</div>
      ) : (
        <>
          {/* SUMMARY */}
          {summary && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
                gap: 10,
              }}
            >
              <Stat
                label={debounced ? 'Downline Rake (All Members)' : 'Downline Rake'}
                value={money(summary.rake_generated)}
                accent
              />
              <Stat
                label="Your Share"
                value={money(summary.estimated_commission)}
                sub={
                  Number.isFinite(Number(summary.commission_rate))
                    ? `at ${Math.round(Number(summary.commission_rate) * 100)}%`
                    : 'rate unavailable'
                }
              />
              <Stat
                label="Members"
                value={count(summary.members)}
                sub={`${count(summary.active)} active`}
              />
              <Stat label="Hands" value={count(summary.hands)} />
              {summary.top_earner?.username && (
                <Stat
                  label="Top Earner"
                  value={summary.top_earner.username}
                  sub={money(summary.top_earner.rake)}
                  small
                />
              )}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span style={{ color: '#66787f', fontSize: '0.75rem' }}>
              {liveAt && (
                <>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: '#37e7c7',
                      marginRight: 6,
                    }}
                  />
                  Live · Updated {liveAt.toLocaleTimeString()}
                </>
              )}
            </span>
            {debounced && (
              <span style={{ color: '#8fa3ad', fontSize: '0.78rem' }}>
                {rows.length} Match{rows.length === 1 ? '' : 'es'} · {money(totals.shown)} Rake
              </span>
            )}
          </div>

          {/* TABLE */}
          {rows.length >= 500 && (
            <p style={{ color: '#f59e0b', fontSize: '0.78rem', margin: '0 0 8px' }}>
              Showing The First 500 Members. The Totals Above Cover Everyone; Search To Find A
              Member Not Listed.
            </p>
          )}
          {rows.length === 0 ? (
            <p style={{ color: '#8aa' }}>
              {debounced
                ? 'No One In Your Downline Matches That Name.'
                : 'No Downline Activity In This Window.'}
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
                <thead>
                  <tr style={{ color: '#7d919b', textAlign: 'left' }}>
                    <th style={{ padding: 8 }}>Member</th>
                    <th style={{ padding: 8 }}>Upline</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>Hands</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>Rake</th>
                    <th style={{ padding: 8, textAlign: 'right' }}>Their Downline</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isAgent = AGENT_ROLES.has(r.role);
                    return (
                      <tr
                        key={r.player_id + r.club_id}
                        onClick={() => drillInto(r)}
                        style={{
                          borderTop: '1px solid #1e2a31',
                          cursor: isAgent ? 'pointer' : 'default',
                        }}
                      >
                        <td style={{ padding: 8, color: '#e6f1f5' }}>
                          {r.username}
                          {isAgent && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: '0.68rem',
                                color: '#37e7c7',
                                border: '1px solid #1f5245',
                                borderRadius: 5,
                                padding: '1px 5px',
                              }}
                            >
                              {r.role.replace('_', ' ')}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: 8, color: '#8fa3ad' }}>{r.upline_name ?? '-'}</td>
                        <td style={{ padding: 8, textAlign: 'right', color: '#8fa3ad' }}>
                          {count(r.hands)}
                        </td>
                        <td
                          style={{
                            padding: 8,
                            textAlign: 'right',
                            color: '#e6f1f5',
                            fontWeight: 600,
                          }}
                        >
                          {money(r.rake_generated)}
                        </td>
                        <td style={{ padding: 8, textAlign: 'right', color: '#8fa3ad' }}>
                          {r.downline_players > 0
                            ? `${count(r.downline_players)} · ${money(r.downline_rake)}`
                            : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ color: '#66787f', fontSize: '0.75rem', margin: 0 }}>
            A Hand's Rake Is Attributed By Weighted Contribution - Each Player's Share Follows What
            They Put Into The Pot - The Same Rule The Weekly Payout Uses, So These Figures Match
            Your Statement. Older Hands Recorded Under The Equal Split Are Reported As They Were
            Paid. Tap An Agent To Open Their Downline.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  small,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${accent ? '#1f5245' : '#1e2a31'}`,
      }}
    >
      <div
        style={{
          color: '#7d919b',
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: accent ? '#37e7c7' : '#e6f1f5',
          fontSize: small ? '1rem' : '1.35rem',
          fontWeight: 700,
          marginTop: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
      {sub && <div style={{ color: '#66787f', fontSize: '0.72rem', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
