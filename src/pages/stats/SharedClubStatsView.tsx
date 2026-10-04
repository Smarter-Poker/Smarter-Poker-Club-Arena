import { useEffect, useRef, useState } from 'react';
import {
  SharedClubStatsService,
  type SharedStatsClub,
} from '../../services/SharedClubStatsService';
import { reportError } from '../../utils/errorReporter';
import { RANGES } from './types';

interface Props {
  targetUserId: string;
  asset: string;
  timezone: string;
  rangeKey: string;
  windowDays: number | null;
  initialClubId: string | null;
  onClubChange: (clubId: string, replace?: boolean) => void;
  onRangeChange: (key: string) => void;
}

export default function SharedClubStatsView(props: Props) {
  const [clubs, setClubs] = useState<SharedStatsClub[]>([]);
  const [clubId, setClubId] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ scope: string; data: any } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [errorStage, setErrorStage] = useState<'clubs' | 'overview' | null>(null);
  const [clubsScope, setClubsScope] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [overviewAttempt, setOverviewAttempt] = useState(0);
  const listRequest = useRef(0);
  const overviewRequest = useRef(0);
  const selectedClub = useRef<string | null>(null);
  const onClubChange = useRef(props.onClubChange);
  onClubChange.current = props.onClubChange;

  const scope = `${props.targetUserId}\u0000${props.asset}`;
  const visibleClubs = clubsScope === scope ? clubs : [];
  const requestedClub = props.initialClubId?.trim() || null;
  const resolvedUrlClubId =
    requestedClub && visibleClubs.some((club) => club.id === requestedClub)
      ? requestedClub
      : (visibleClubs[0]?.id ?? null);
  const displayClubId = resolvedUrlClubId ?? clubId;
  const displayOverviewScope = displayClubId
    ? [scope, displayClubId, props.windowDays ?? 'all', props.timezone].join('\u0000')
    : null;
  const readyPayload =
    displayOverviewScope && payload?.scope === displayOverviewScope ? payload.data : null;
  const displayState = state === 'ready' && !readyPayload ? 'loading' : state;

  useEffect(() => {
    const request = ++listRequest.current;
    overviewRequest.current += 1;
    selectedClub.current = null;
    setClubs([]);
    setClubsScope(null);
    setClubId(null);
    setPayload(null);
    setErrorStage(null);
    setState('loading');

    SharedClubStatsService.listClubs(props.targetUserId, props.asset)
      .then((rows) => {
        if (listRequest.current !== request) return;
        setClubs(rows);
        setClubsScope(scope);
        if (rows.length === 0) setState('empty');
      })
      .catch((error) => {
        if (listRequest.current !== request) return;
        reportError(error, 'SharedClubStatsView.listClubs');
        setErrorStage('clubs');
        setState('error');
      });

    return () => {
      if (listRequest.current === request) listRequest.current += 1;
    };
  }, [props.targetUserId, props.asset, scope, listAttempt]);

  useEffect(() => {
    if (clubsScope !== scope || clubs.length === 0) return;

    const nextClub =
      requestedClub && clubs.some((club) => club.id === requestedClub)
        ? requestedClub
        : clubs[0].id;

    if (selectedClub.current !== nextClub) {
      overviewRequest.current += 1;
      selectedClub.current = nextClub;
      setClubId(nextClub);
    }
    if (requestedClub !== nextClub) onClubChange.current(nextClub, true);
  }, [clubs, clubsScope, requestedClub, scope]);

  useEffect(() => {
    if (clubsScope !== scope || !clubId || !clubs.some((club) => club.id === clubId)) {
      return;
    }

    const request = ++overviewRequest.current;
    const requestScope = [scope, clubId, props.windowDays ?? 'all', props.timezone].join('\u0000');
    setPayload(null);
    setErrorStage(null);
    setState('loading');

    SharedClubStatsService.getOverview(
      props.targetUserId,
      clubId,
      props.windowDays,
      props.timezone,
      props.asset
    )
      .then((data) => {
        if (overviewRequest.current !== request) return;
        setPayload({ scope: requestScope, data });
        setState('ready');
      })
      .catch((error) => {
        if (overviewRequest.current !== request) return;
        reportError(error, 'SharedClubStatsView.getOverview');
        setErrorStage('overview');
        setState('error');
      });

    return () => {
      if (overviewRequest.current === request) overviewRequest.current += 1;
    };
  }, [
    props.targetUserId,
    props.asset,
    props.timezone,
    props.windowDays,
    clubs,
    clubsScope,
    clubId,
    scope,
    overviewAttempt,
  ]);

  const choose = (id: string) => {
    if (selectedClub.current === id) return;
    overviewRequest.current += 1;
    selectedClub.current = id;
    setClubId(id);
    setPayload(null);
    setErrorStage(null);
    setState('loading');
    props.onClubChange(id);
  };

  const retry = () => {
    setErrorStage(null);
    setState('loading');
    if (errorStage === 'clubs') setListAttempt((attempt) => attempt + 1);
    if (errorStage === 'overview') setOverviewAttempt((attempt) => attempt + 1);
  };

  const o = readyPayload?.overview ?? {};
  const t = readyPayload?.tournaments ?? {};
  return (
    <div className="stats-page">
      <section className="stats-command-deck">
        <img
          className="stats-hero-art"
          src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-dossier-v2.webp`}
          alt=""
          aria-hidden="true"
        />
        <div className="stats-command-copy">
          <span className="stats-eyebrow">Authorized Shared-Club Readout</span>
          <h1>Player Intelligence</h1>
          <p>Public Performance Aggregates From A Club You Both Currently Share.</p>
        </div>
      </section>
      {visibleClubs.length > 0 && (
        <section className="stats-club-command" aria-labelledby="shared-club-title">
          <img
            src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-console-v1.webp`}
            alt=""
            aria-hidden="true"
          />
          <div className="stats-club-command-copy">
            <span className="stats-section-kicker">Exact Shared Scope</span>
            <h2 id="shared-club-title">
              {visibleClubs.find((c) => c.id === displayClubId)?.name ?? 'Shared Club'}
            </h2>
            <p>No All-Clubs, Private Financial, Hand, Note, Or Opponent Data Is Exposed.</p>
            <div className="stats-club-selector" role="group" aria-label="Shared Statistics Club">
              {visibleClubs.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={c.id === displayClubId ? 'active' : ''}
                  aria-pressed={c.id === displayClubId}
                  onClick={() => choose(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
      <div className="stats-range-selector" role="group" aria-label="Statistics Range">
        {RANGES.map((r) => (
          <button
            type="button"
            key={r.key}
            className={r.key === props.rangeKey ? 'active' : ''}
            aria-pressed={r.key === props.rangeKey}
            onClick={() => props.onRangeChange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {displayState === 'loading' && (
        <div className="stats-empty-state" role="status">
          <span className="empty-title">Opening Shared Readout...</span>
        </div>
      )}
      {displayState === 'empty' && (
        <div className="stats-empty-state" role="status">
          <span className="empty-title">No Eligible Shared Club</span>
          <span className="empty-description">
            Both Players Must Have Active Or Approved Membership In The Same Club.
          </span>
        </div>
      )}
      {displayState === 'error' && (
        <div className="stats-empty-state" role="alert">
          <span className="empty-title">Shared Readout Unavailable</span>
          <span className="empty-description">
            {errorStage === 'clubs'
              ? 'Club Access Could Not Be Verified.'
              : 'The Selected Club Readout Could Not Be Opened.'}
          </span>
          <button type="button" className="stats-retry-button" onClick={retry}>
            {errorStage === 'clubs' ? 'Retry Club Access' : 'Retry Shared Readout'}
          </button>
        </div>
      )}
      {displayState === 'ready' && readyPayload && (
        <section className="stats-club-comparison" aria-label="Shared Club Public Aggregates">
          <div className="stats-club-comparison-head">
            <div>
              <span className="stats-section-kicker">Public Aggregate Ledger</span>
              <h2>Performance Readout</h2>
            </div>
          </div>
          <div className="stats-club-table-wrap">
            <table className="stats-club-table">
              <thead>
                <tr>
                  <th>Hands</th>
                  <th>Won</th>
                  <th>BB/100</th>
                  <th>VPIP</th>
                  <th>PFR</th>
                  <th>Tournaments</th>
                  <th>Cashes</th>
                  <th>Wins</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{o.hands ?? 0}</td>
                  <td>{o.hands_won ?? 0}</td>
                  <td>{o.bb_per_100 ?? 0}</td>
                  <td>{((o.vpip ?? 0) * 100).toFixed(1)}%</td>
                  <td>{((o.pfr ?? 0) * 100).toFixed(1)}%</td>
                  <td>{t.entries ?? 0}</td>
                  <td>{t.cashes ?? 0}</td>
                  <td>{t.wins ?? 0}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
