import { useEffect, useState } from 'react';
import {
  SharedClubStatsService,
  type SharedStatsClub,
} from '../../services/SharedClubStatsService';
import { RANGES } from './types';

interface Props {
  targetUserId: string;
  asset: string;
  timezone: string;
  rangeKey: string;
  windowDays: number | null;
  initialClubId: string | null;
  onClubChange: (clubId: string) => void;
  onRangeChange: (key: string) => void;
}

export default function SharedClubStatsView(props: Props) {
  const [clubs, setClubs] = useState<SharedStatsClub[]>([]);
  const [clubId, setClubId] = useState<string | null>(props.initialClubId);
  const [payload, setPayload] = useState<any>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    setState('loading');
    SharedClubStatsService.listClubs(props.targetUserId, props.asset)
      .then((rows) => {
        if (!live) return;
        setClubs(rows);
        const selected = rows.some((c) => c.id === clubId) ? clubId : (rows[0]?.id ?? null);
        setClubId(selected);
        if (selected) props.onClubChange(selected);
        else setState('empty');
      })
      .catch(() => live && setState('error'));
    return () => {
      live = false;
    };
    // Callback is intentionally excluded: URL synchronization must not refetch access.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.targetUserId, props.asset]);
  useEffect(() => {
    if (!clubId) return;
    let live = true;
    setState('loading');
    SharedClubStatsService.getOverview(
      props.targetUserId,
      clubId,
      props.windowDays,
      props.timezone,
      props.asset
    )
      .then((data) => {
        if (live) {
          setPayload(data);
          setState('ready');
        }
      })
      .catch(() => live && setState('error'));
    return () => {
      live = false;
    };
  }, [props.targetUserId, props.asset, props.timezone, props.windowDays, clubId]);
  const choose = (id: string) => {
    setClubId(id);
    props.onClubChange(id);
  };
  const o = payload?.overview ?? {};
  const t = payload?.tournaments ?? {};
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
      {clubs.length > 0 && (
        <section className="stats-club-command" aria-labelledby="shared-club-title">
          <img
            src={`${import.meta.env.BASE_URL}images/stats/player-intelligence-console-v1.webp`}
            alt=""
            aria-hidden="true"
          />
          <div className="stats-club-command-copy">
            <span className="stats-section-kicker">Exact Shared Scope</span>
            <h2 id="shared-club-title">
              {clubs.find((c) => c.id === clubId)?.name ?? 'Shared Club'}
            </h2>
            <p>No All-Clubs, Private Financial, Hand, Note, Or Opponent Data Is Exposed.</p>
            <div className="stats-club-selector" role="group" aria-label="Shared Statistics Club">
              {clubs.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={c.id === clubId ? 'active' : ''}
                  aria-pressed={c.id === clubId}
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
      {state === 'loading' && (
        <div className="stats-empty-state" role="status">
          <span className="empty-title">Opening Shared Readout...</span>
        </div>
      )}
      {state === 'empty' && (
        <div className="stats-empty-state" role="status">
          <span className="empty-title">No Eligible Shared Club</span>
          <span className="empty-description">
            Both Players Must Have Active Or Approved Membership In The Same Club.
          </span>
        </div>
      )}
      {state === 'error' && (
        <div className="stats-empty-state" role="alert">
          <span className="empty-title">Shared Readout Unavailable</span>
        </div>
      )}
      {state === 'ready' && (
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
