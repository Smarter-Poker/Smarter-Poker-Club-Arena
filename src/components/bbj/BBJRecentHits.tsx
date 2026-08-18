/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ RECENT HITS — the last jackpots, PokerBros style (2026-08-18)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: tapping the jackpot amount at the top of a table should show the last 5
 * jackpots — the hands, the payouts, and who got paid what.
 *
 * Every figure comes from fn_bbj_recent_hits, which reads the payout ledger and
 * derives each player's ROLE from which uid actually received which share. It
 * deliberately does not trust the stored column names: in bbj_payouts /
 * bbj_winners, "winner" means winner OF THE JACKPOT (the bad-beat holder, who
 * LOST the hand) and "loser" means the player who won the pot. Reading those
 * columns naively puts the wrong name against the wrong hand — which is exactly
 * what the old jackpot-page history line did.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './BBJRecentHits.css';

export interface BBJRecentHitsProps {
  poolId: string | null;
  limit?: number;
  /** Highlights the viewer's own name in the payout list. */
  currentUserName?: string | null;
}

interface Recipient {
  name: string;
  amount: number;
  role: 'bad_beat' | 'hand_winner' | 'table';
}

interface Hit {
  payout_id: string;
  awarded_at: string;
  hand_number: number;
  total_payout: number;
  bad_beat_name: string;
  bad_beat_hand: string | null;
  bad_beat_amount: number | null;
  hand_winner_name: string;
  hand_winner_hand: string | null;
  hand_winner_amount: number | null;
  table_player_count: number | null;
  recipients: Recipient[];
}

function money(n: number | null | undefined, dp = 2): string {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const ROLE_LABEL: Record<Recipient['role'], string> = {
  bad_beat: 'Bad beat',
  hand_winner: 'Won the hand',
  table: 'At the table',
};

export function BBJRecentHits({ poolId, limit = 5, currentUserName }: BBJRecentHitsProps) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!poolId) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_bbj_recent_hits', {
          p_pool_id: poolId,
          p_limit: limit,
        });
        if (!alive) return;
        if (error) {
          setFailed(true);
          reportError(error, 'BBJRecentHits.load_failed');
          return;
        }
        // jsonb arrives parsed, but this renders money — never let a shape
        // surprise throw inside the map and blank the whole panel.
        const rows = ((data || []) as Hit[]).map((h) => ({
          ...h,
          recipients: Array.isArray(h.recipients) ? h.recipients : [],
        }));
        setHits(rows);
        // Open the most recent hit by default — the one people came to see.
        if (rows.length > 0) setExpanded(rows[0].payout_id);
      } catch (e) {
        if (alive) {
          setFailed(true);
          reportError(e, 'BBJRecentHits.threw');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [poolId, limit]);

  if (!poolId) return null;

  if (failed) {
    return (
      <div className="bbj-hits__empty">Couldn&rsquo;t load recent jackpots. Try again shortly.</div>
    );
  }

  if (hits === null) {
    return (
      <div className="bbj-hits">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bbj-hits__skeleton" />
        ))}
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="bbj-hits__empty">
        No jackpot has hit here yet.
        <span className="bbj-hits__empty-sub">The next one could be yours.</span>
      </div>
    );
  }

  return (
    <div className="bbj-hits">
      {hits.map((hit) => {
        const isOpen = expanded === hit.payout_id;
        return (
          <div className={`bbj-hits__card${isOpen ? ' is-open' : ''}`} key={hit.payout_id}>
            <button
              className="bbj-hits__head"
              onClick={() => setExpanded(isOpen ? null : hit.payout_id)}
              aria-expanded={isOpen}
            >
              <div className="bbj-hits__head-left">
                <span className="bbj-hits__total">${money(hit.total_payout, 0)}</span>
                <span className="bbj-hits__when">{when(hit.awarded_at)}</span>
              </div>
              <div className="bbj-hits__head-right">
                {/* The bad-beat holder LOST the hand — say so plainly. */}
                <span className="bbj-hits__matchup">
                  <strong>{hit.bad_beat_hand || 'Qualifying hand'}</strong> lost to{' '}
                  <strong>{hit.hand_winner_hand || 'a bigger hand'}</strong>
                </span>
                <span className="bbj-hits__names">
                  {hit.bad_beat_name} &middot; {hit.table_player_count || 0} at the table
                </span>
              </div>
              <span className="bbj-hits__chev" aria-hidden="true">
                {isOpen ? '–' : '+'}
              </span>
            </button>

            {isOpen && (
              <div className="bbj-hits__body">
                <div className="bbj-hits__payouts">
                  {hit.recipients.map((r, i) => {
                    const isYou =
                      !!currentUserName && r.name.toLowerCase() === currentUserName.toLowerCase();
                    return (
                      <div
                        className={`bbj-hits__row bbj-hits__row--${r.role}${isYou ? ' is-you' : ''}`}
                        key={`${hit.payout_id}-${i}`}
                      >
                        <span className="bbj-hits__who">
                          {r.name}
                          {isYou && <span className="bbj-hits__you">YOU</span>}
                        </span>
                        <span className="bbj-hits__role">{ROLE_LABEL[r.role]}</span>
                        <span className="bbj-hits__amt">+${money(r.amount)}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="bbj-hits__foot">
                  <span>
                    {hit.bad_beat_name} held {hit.bad_beat_hand || 'a qualifying hand'} and lost to{' '}
                    {hit.hand_winner_name}
                    {hit.hand_winner_hand ? `'s ${hit.hand_winner_hand}` : ''}.
                  </span>
                  <span className="bbj-hits__hand-no">Hand #{hit.hand_number}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default BBJRecentHits;
