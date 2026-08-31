/**
 * NemesisPanel — who has been taking chips off you, and who you have been
 * taking them off.
 *
 * DATA HONESTY
 * ------------
 * Head-to-head chip flow is not recoverable from hand_history: winners[].amount
 * is gross, and in a multiway pot the JSON never says whose money it was. So
 * this reads ca_hand_transfers, written at settlement with hand-level
 * proportional attribution (each winner takes from each loser in proportion to
 * that loser's share of the hand's losses). Chips are conserved exactly, and
 * rake is attributed to nobody — the house took that, not the villain.
 *
 * Shared-hand counts come from ca_hand_facts.opponent_ids rather than from the
 * transfers, because two players who both lose a hand exchange nothing and a
 * transfer-derived count would silently omit exactly those hands.
 *
 * MINIMUM SAMPLE: 25 shared hands, enforced server-side. Below that a
 * "nemesis" is one cooler, not a rivalry, and crowning someone off a single
 * hand would make the whole feature feel arbitrary.
 *
 * ON OPPONENTS: most opponents in the club are horses. They are named,
 * persistent characters with real playing styles, and they are deliberately
 * not visually distinguished here — "Steeltrap has taken 14,200 off you" is a
 * true and engaging statement regardless. They are never called bots.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StatsFactsService, {
  type NemesisPayload,
  type OpponentFlow,
} from '../../services/StatsFactsService';
import './NemesisPanel.css';
import { sizedStorageUrl } from '../../utils/avatarGenerator';

interface Props {
  userId?: string;
  days?: number | null;
}

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function chips(n: number): string {
  return Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function Avatar({ flow }: { flow: OpponentFlow }) {
  if (flow.avatar_url) {
    return (
      <img
        className="nemesis-avatar"
        src={sizedStorageUrl(flow.avatar_url, 40)}
        alt=""
        loading="lazy"
      />
    );
  }
  return (
    <span className="nemesis-avatar nemesis-avatar-fallback" aria-hidden="true">
      {initials(flow.username)}
    </span>
  );
}

function FlowCard({
  flow,
  kind,
  onOpen,
}: {
  flow: OpponentFlow;
  kind: 'nemesis' | 'target';
  onOpen: (id: string) => void;
}) {
  const isNemesis = kind === 'nemesis';
  return (
    <button
      type="button"
      className={`nemesis-card ${isNemesis ? 'is-nemesis' : 'is-target'}`}
      onClick={() => onOpen(flow.opponent_id)}
    >
      <span className="nemesis-kind">{isNemesis ? 'Your Nemesis' : 'Your Target'}</span>
      <span className="nemesis-identity">
        <Avatar flow={flow} />
        <span className="nemesis-name">{flow.username ?? 'Unknown Player'}</span>
      </span>
      {/* Sign and colour come from the VALUE, never from which card this is:
          the two must agree with the expanded table below, which derives both
          from net_chips. */}
      <span className={`nemesis-amount ${flow.net_chips >= 0 ? 'is-up' : 'is-down'}`}>
        {flow.net_chips >= 0 ? '+' : '-'}
        {chips(flow.net_chips)}
      </span>
      <span className="nemesis-meta">{flow.hands_together.toLocaleString()} Hands Together</span>
    </button>
  );
}

export default function NemesisPanel({ userId, days = null }: Props) {
  const navigate = useNavigate();
  const [data, setData] = useState<NemesisPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    StatsFactsService.getNemesis(userId, { days })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, days]);

  const rows = useMemo(() => {
    if (!data) return [];
    // Worst first: the player wants to know who is beating them.
    return [...(data.worst ?? []), ...(data.best ?? [])].sort((a, b) => a.net_chips - b.net_chips);
  }, [data]);

  // Cross-player Stats are private until a club-scoped authorization contract
  // exists. Rival actions therefore open the real public profile rather than a
  // guaranteed private-state dead end.
  const openProfile = (id: string) => navigate(`/profile/${id}`);

  if (loading) {
    return (
      <div className="nemesis-panel">
        <div className="nemesis-skeleton" />
      </div>
    );
  }

  const hasAny = !!(data?.nemesis || data?.target);

  if (!hasAny) {
    return (
      <div className="nemesis-panel nemesis-empty">
        <h3 className="nemesis-title">Rivals</h3>
        <p className="nemesis-empty-text">
          No Rivalries Yet. An Opponent Appears Here Once You Have Played At Least{' '}
          {data?.min_hands ?? 25} Hands Against Them, So That A Single Big Pot Cannot Crown Someone
          Who Simply Got Lucky Once.
        </p>
      </div>
    );
  }

  return (
    <div className="nemesis-panel">
      <div className="nemesis-head">
        <h3 className="nemesis-title">Rivals</h3>
        <p className="nemesis-sub">
          Net Chips Won And Lost Against Each Opponent, Across {data?.opponents_qualified ?? 0}{' '}
          Players You Have Met At Least {data?.min_hands ?? 25} Times.
        </p>
      </div>

      <div className="nemesis-cards">
        {data?.nemesis && <FlowCard flow={data.nemesis} kind="nemesis" onOpen={openProfile} />}
        {data?.target && <FlowCard flow={data.target} kind="target" onOpen={openProfile} />}
      </div>

      {rows.length > 2 && (
        <>
          <button
            type="button"
            className="nemesis-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Hide Full List' : `Show Top ${rows.length} Rivals`}
          </button>

          {expanded && (
            <table className="nemesis-table">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Hands</th>
                  <th scope="col">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.opponent_id}
                    tabIndex={0}
                    role="link"
                    aria-label={`View ${r.username ?? 'this player'}'S Profile`}
                    onClick={() => openProfile(r.opponent_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openProfile(r.opponent_id);
                      }
                    }}
                  >
                    <th scope="row">
                      <Avatar flow={r} />
                      <span className="nemesis-row-name">{r.username ?? 'Unknown Player'}</span>
                    </th>
                    <td>{r.hands_together.toLocaleString()}</td>
                    <td className={r.net_chips >= 0 ? 'is-up' : 'is-down'}>
                      {r.net_chips >= 0 ? '+' : '-'}
                      {chips(r.net_chips)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <p className="nemesis-note">
        Chip Flow Is Attributed Per Hand In Proportion To What Each Player Lost. Rake Is Not Counted
        Against Any Opponent.
      </p>
    </div>
  );
}
