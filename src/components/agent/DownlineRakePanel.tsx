import { usePlayerPreference } from '../../hooks/usePlayerPreference';
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
type RakeSnapshot = {
  scope: string;
  rows: DownlineRakeRow[];
  summary: DownlineRakeSummary;
  liveAt: Date;
  hasMore: boolean;
};

export default function DownlineRakePanel({
  roles,
  liveRevision = 0,
  viewerId,
}: {
  roles: AgentRoleRow[];
  liveRevision?: number;
  viewerId?: string;
}) {
  const [savedClubId, setClubId] = usePlayerPreference<string>(
    'downlineRake.club',
    roles[0]?.club_id ?? '',
    'global'
  );
  const clubId = roles.some((role) => role.club_id === savedClubId)
    ? savedClubId
    : (roles[0]?.club_id ?? '');
  const [win, setWin] = usePlayerPreference<RakeWindowKey>('downlineRake.window', 'week', clubId);
  const [search, setSearch] = usePlayerPreference('downlineRake.search', '', clubId);
  const [debounced, setDebounced] = useState('');
  const [snapshot, setSnapshot] = useState<RakeSnapshot | null>(null);
  const [loadingRead, setLoading] = useState(true);
  const [readError, setError] = useState<{ scope: string; message: string } | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [rowLimit, setRowLimit] = useState(PAGE_SIZE);

  const inFlight = useRef<{ key: string; controller: AbortController } | null>(null);
  const pending = useRef(false);
  const latestLoad = useRef<(quiet?: boolean) => Promise<void>>(async () => undefined);
  const mounted = useRef(true);

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    if (search === debounced) return;
    const t = setTimeout(() => {
      setRowLimit(PAGE_SIZE);
      setDebounced(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search, debounced]);

  const focusUserId = crumbs.length ? crumbs[crumbs.length - 1].userId : undefined;
  const scope = JSON.stringify([viewerId, clubId, win, debounced, focusUserId]);
  const requestKey = JSON.stringify([scope, rowLimit]);
  const latestScope = useRef(requestKey);
  latestScope.current = requestKey;
  const current = snapshot?.scope === scope ? snapshot : null;
  const rows = current?.rows ?? [];
  const summary = current?.summary ?? null;
  const liveAt = current?.liveAt ?? null;
  const hasMore = current?.hasMore ?? false;
  const error = readError?.scope === scope ? readError.message : null;
  // An unverified new scope is loading, never an empty downline.
  const loading = loadingRead || (!current && !error);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.controller.abort();
      inFlight.current = null;
      pending.current = false;
    };
  }, []);

  const load = useCallback(
    async (quiet = false) => {
      if (!mounted.current) return;
      // Record events coalesce behind the current read. A new scope cancels
      // its predecessor immediately and owns every subsequent state update.
      if (inFlight.current?.key === requestKey) {
        pending.current = true;
        return;
      }
      inFlight.current?.controller.abort();
      const request = { key: requestKey, controller: new AbortController() };
      inFlight.current = request;
      pending.current = false;
      const ownsRead = () =>
        mounted.current &&
        inFlight.current === request &&
        latestScope.current === requestKey &&
        !request.controller.signal.aborted;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const { since, until } = windowToRange(win);
        const args = {
          agentUserId: focusUserId,
          clubId: clubId || undefined,
          since,
          until,
          signal: request.controller.signal,
        };
        const [r, s] = await Promise.all([
          AgentRakeService.getDownlineRake({
            ...args,
            search: debounced,
            limit: rowLimit + 1,
          }),
          AgentRakeService.getDownlineRakeSummary(args),
        ]);
        if (!ownsRead()) return;
        if (!s) throw new Error('Downline rake summary was not returned');
        setSnapshot({
          scope,
          rows: r.slice(0, rowLimit),
          hasMore: r.length > rowLimit,
          summary: s,
          liveAt: new Date(),
        });
        setError(null);
      } catch (e) {
        if (!ownsRead()) return;
        setError({ scope, message: describeRakeError(e) });
        reportError(e, 'DownlineRakePanel.load');
      } finally {
        if (ownsRead()) {
          inFlight.current = null;
          setLoading(false);
          if (pending.current) {
            pending.current = false;
            void latestLoad.current(true);
          }
        }
      }
    },
    [clubId, win, debounced, focusUserId, rowLimit, requestKey, scope]
  );
  latestLoad.current = load;

  const requestedScope = useRef<string | null>(null);
  useEffect(() => {
    const quiet = requestedScope.current === requestKey;
    requestedScope.current = requestKey;
    void load(quiet);
    // The parent owns record_changed/pulse coalescing and reconnect reads.
  }, [load, requestKey, liveRevision]);

  const totals = useMemo(() => {
    const shown = rows.reduce((s, r) => s + Number(r.rake_generated || 0), 0);
    return { shown };
  }, [rows]);

  const drillInto = (r: DownlineRakeRow) => {
    if (!AGENT_ROLES.has(r.role)) return;
    setRowLimit(PAGE_SIZE);
    setCrumbs((c) => [...c, { userId: r.player_id, name: r.username ?? 'Agent' }]);
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
                label={debounced ? 'Downline Cash Rake (All Members)' : 'Downline Cash Rake'}
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
              <Stat label="Raked Hands" value={count(summary.hands)} />
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
              {liveAt && <>Live Record Updates / Last Checked {liveAt.toLocaleTimeString()}</>}
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
                    <th className="dlr-number">Raked Hands</th>
                    <th className="dlr-number">Cash Rake</th>
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
            Paid. Cash-Game Rake Only: Tournament Fees Are Not Included, So This Is Not The Roster's
            Downline Fees Total. Raked Hands Counts Only Hands That Took Rake From The Player. Open
            An Agent To Read Their Downline.
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
