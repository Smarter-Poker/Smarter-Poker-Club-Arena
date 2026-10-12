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
import { enumToTitleCase, titleCase } from '../../utils/titleCase';
import './DownlineRakePanel.css';

const money = (n: unknown) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n) || 0);
const count = (n: unknown) => new Intl.NumberFormat('en-US').format(Number(n) || 0);

const AGENT_ROLES = new Set(['super_agent', 'agent', 'sub_agent']);
const PAGE_SIZE = 500;

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
  const [rowLimit, setRowLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);

  const inFlight = useRef(false);
  const pending = useRef(false);
  const latestLoad = useRef<(quiet?: boolean) => Promise<void>>(async () => undefined);

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setRowLimit(PAGE_SIZE);
      setDebounced(search);
    }, 300);
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
          AgentRakeService.getDownlineRake({
            ...args,
            search: debounced,
            limit: rowLimit + 1,
          }),
          AgentRakeService.getDownlineRakeSummary(args),
        ]);
        setRows(r.slice(0, rowLimit));
        setHasMore(r.length > rowLimit);
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
          void latestLoad.current(true);
        }
      }
    },
    [clubId, win, debounced, focusUserId, rowLimit]
  );
  latestLoad.current = load;

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
    setRowLimit(PAGE_SIZE);
    setCrumbs((c) => [...c, { userId: r.player_id, name: r.username ?? 'Agent' }]);
    setSearch('');
  };

  const popTo = (i: number) => {
    setRowLimit(PAGE_SIZE);
    setCrumbs((c) => c.slice(0, i));
  };

  return (
    <section className="dlr-panel" aria-label="Downline Rake Ledger">
      <div className="dlr-controls">
        {roles.length > 1 && (
          <select
            aria-label="Club"
            value={clubId}
            onChange={(e) => {
              setRowLimit(PAGE_SIZE);
              setClubId(e.target.value);
              setCrumbs([]);
            }}
          >
            {roles.map((r) => (
              <option key={r.club_id} value={r.club_id}>
                {r.club_name ?? 'Club'} / {enumToTitleCase(r.role)}
              </option>
            ))}
          </select>
        )}
        <div className="dlr-window-controls" role="group" aria-label="Rake Window">
          {RAKE_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              className={win === w.key ? 'dlr-control dlr-control--active' : 'dlr-control'}
              aria-pressed={win === w.key}
              onClick={() => {
                setRowLimit(PAGE_SIZE);
                setWin(w.key);
              }}
            >
              {titleCase(w.label)}
            </button>
          ))}
        </div>
        <input
          aria-label="Search Downline Players"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search A Player..."
        />
      </div>

      {crumbs.length > 0 && (
        <nav className="dlr-breadcrumbs" aria-label="Downline Path">
          <button type="button" onClick={() => popTo(0)}>
            My Downline
          </button>
          {crumbs.map((c, i) => (
            <span key={c.userId}>
              <button
                type="button"
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                onClick={() => popTo(i + 1)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {error ? (
        <div className="dlr-error" role="alert">
          <span>{titleCase(error)}</span>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="dlr-loading" role="status">
          Loading Downline Rake...
        </div>
      ) : (
        <>
          {summary && (
            <dl className="dlr-summary">
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
                    ? `At ${Math.round(Number(summary.commission_rate) * 100)}%`
                    : 'Rate Unavailable'
                }
              />
              <Stat
                label="Members"
                value={count(summary.members)}
                sub={`${count(summary.active)} Active`}
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
            </dl>
          )}

          <div className="dlr-read-status">
            <span>
              {liveAt && <>Verified 30-Second Poll / Last Checked {liveAt.toLocaleTimeString()}</>}
            </span>
            {debounced && (
              <span>
                {rows.length} Match{rows.length === 1 ? '' : 'es'} / {money(totals.shown)} Rake
              </span>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="dlr-empty">
              {debounced
                ? 'No One In Your Downline Matches That Name.'
                : 'No Downline Activity In This Window.'}
            </p>
          ) : (
            <div className="dlr-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Upline</th>
                    <th className="dlr-number">Hands</th>
                    <th className="dlr-number">Rake</th>
                    <th className="dlr-number">Their Downline</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isAgent = AGENT_ROLES.has(r.role);
                    return (
                      <tr key={r.player_id + r.club_id}>
                        <td>
                          {isAgent ? (
                            <button
                              type="button"
                              className="dlr-member-action"
                              onClick={() => drillInto(r)}
                              aria-label={`Open ${r.username ?? 'Agent'} Downline`}
                            >
                              <span>{r.username ?? 'Agent'}</span>
                              <small>{enumToTitleCase(r.role)}</small>
                            </button>
                          ) : (
                            <span className="dlr-member-name">{r.username ?? 'Player'}</span>
                          )}
                        </td>
                        <td>{r.upline_name ?? '-'}</td>
                        <td className="dlr-number">{count(r.hands)}</td>
                        <td className="dlr-number dlr-rake">{money(r.rake_generated)}</td>
                        <td className="dlr-number">
                          {r.downline_players > 0
                            ? `${count(r.downline_players)} / ${money(r.downline_rake)}`
                            : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && (
            <div className="dlr-pagination" role="status">
              <p>
                Showing {count(rows.length)} Members. The Totals Above Cover The Full Authorized
                Downline.
              </p>
              <button type="button" onClick={() => setRowLimit((limit) => limit + PAGE_SIZE)}>
                Show 500 More Members
              </button>
            </div>
          )}

          <p className="dlr-method-note">
            A Hand's Rake Is Attributed By Weighted Contribution - Each Player's Share Follows What
            They Put Into The Pot - The Same Rule The Weekly Payout Uses, So These Figures Match
            Your Statement. Older Hands Recorded Under The Equal Split Are Reported As They Were
            Paid. Open An Agent To Read Their Downline.
          </p>
        </>
      )}
    </section>
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
    <div className={accent ? 'dlr-stat dlr-stat--accent' : 'dlr-stat'}>
      <dt>{label}</dt>
      <dd className={small ? 'dlr-stat__value dlr-stat__value--small' : 'dlr-stat__value'}>
        {value}
      </dd>
      {sub && <dd className="dlr-stat__meta">{sub}</dd>}
    </div>
  );
}
