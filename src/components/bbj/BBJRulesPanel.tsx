/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ RULES PANEL — what qualifies, and what this stake actually pays
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The jackpot page used to state ONE hardcoded qualifying rule
 * ("Quad 2s or better beaten") which was wrong for every game we spread, and
 * showed a 50/25/25 split with no mention that a table pays only a
 * stakes-tiered slice of the pool. A player at 0.10/0.20 reading a $9,000
 * jackpot and a 50% loser share would reasonably expect $4,500 — the real
 * number is 15% of the pool, so $1,350 goes to the split, and the bad-beat
 * holder gets $675.
 *
 * Both tables here are generated from the SAME config the server pays from,
 * so they cannot drift into fiction again.
 */

import { useState } from 'react';
import {
  BBJ_QUALIFYING_HANDS,
  BBJ_RULES,
  getBBJPayoutPercentForBB,
  getBBJQualifyingInfo,
} from '../../config/RakeConfig';
import './BBJRulesPanel.css';

/** Stakes tiers as the SERVER pays them (server/src/config/RakeConfig.ts). */
const PAYOUT_TIERS: Array<{ label: string; blinds: string; sampleBB: number }> = [
  { label: 'Nano', blinds: '0.05/0.10 – 0.10/0.20', sampleBB: 0.2 },
  { label: 'Micro', blinds: '0.20/0.40 – 0.40/0.80', sampleBB: 0.8 },
  { label: 'Small', blinds: '0.50/1 – 1.50/3', sampleBB: 3 },
  { label: 'Mid', blinds: '2/4 – 4/8', sampleBB: 8 },
  { label: 'High', blinds: '5/10 – 20/40', sampleBB: 40 },
  { label: 'Nosebleeds', blinds: '25/50+', sampleBB: 50 },
];

/** One row per distinct variant rule (aliases collapsed). */
const VARIANT_ROWS: Array<{ key: string; games: string }> = [
  { key: 'nlh', games: "No Limit / Fixed Limit Hold'em" },
  { key: 'plo4', games: 'PLO4 / FLO4' },
  { key: 'plo8', games: 'PLO8 (Hi-Lo)' },
  { key: 'plo5', games: 'PLO5 / FLO5' },
  { key: 'plo6', games: 'PLO6' },
  { key: 'short_deck', games: 'Short Deck' },
];

export interface BBJRulesPanelProps {
  /** Live main pool, so the payout table can show real chip figures. */
  poolAmount?: number;
}

function chips(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function BBJRulesPanel({ poolAmount = 0 }: BBJRulesPanelProps) {
  const [tab, setTab] = useState<'qualifying' | 'payout'>('qualifying');

  return (
    <div className="bbj-rules">
      <div className="bbj-rules__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'qualifying'}
          className={`bbj-rules__tab${tab === 'qualifying' ? ' is-active' : ''}`}
          onClick={() => setTab('qualifying')}
        >
          What qualifies
        </button>
        <button
          role="tab"
          aria-selected={tab === 'payout'}
          className={`bbj-rules__tab${tab === 'payout' ? ' is-active' : ''}`}
          onClick={() => setTab('payout')}
        >
          What it pays
        </button>
      </div>

      {tab === 'qualifying' && (
        <div className="bbj-rules__body">
          <table className="bbj-rules__table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Losing hand must be</th>
              </tr>
            </thead>
            <tbody>
              {VARIANT_ROWS.map((row) => {
                const q = BBJ_QUALIFYING_HANDS[row.key];
                const info = getBBJQualifyingInfo(row.key);
                const eligible = q?.eligible !== false;
                return (
                  <tr key={row.key} className={eligible ? '' : 'is-ineligible'}>
                    <td>{row.games}</td>
                    <td>{eligible ? info.shortLabel : 'Jackpot not available'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="bbj-rules__list">
            <li>Minimum pot: {BBJ_RULES.minPotBB} big blinds</li>
            <li>Minimum players dealt in: {BBJ_RULES.minPlayersDealt}</li>
            {BBJ_RULES.requireBothHoleCards && (
              <li>
                Both hole cards must play (in Omaha games, exactly two) &mdash; for both the losing
                and the winning hand
              </li>
            )}
            {BBJ_RULES.onlyFirstRunout && (
              <li>When a pot is run twice or three times, only the FIRST board can trigger it</li>
            )}
          </ul>
        </div>
      )}

      {tab === 'payout' && (
        <div className="bbj-rules__body">
          <p className="bbj-rules__note">
            A jackpot hit pays a share of the main pool set by the stakes you were playing &mdash;
            not the whole pool. That share is then split 50% to the bad-beat hand, 25% to the hand
            that won, and 25% between everyone else dealt into the hand.
          </p>

          <table className="bbj-rules__table">
            <thead>
              <tr>
                <th>Stakes</th>
                <th>Pays</th>
                {poolAmount > 0 && <th>At today&rsquo;s pool</th>}
              </tr>
            </thead>
            <tbody>
              {PAYOUT_TIERS.map((t) => {
                const pct = getBBJPayoutPercentForBB(t.sampleBB);
                const total = (poolAmount * pct) / 100;
                return (
                  <tr key={t.label}>
                    <td>
                      <span className="bbj-rules__tier">{t.label}</span>
                      <span className="bbj-rules__blinds">{t.blinds}</span>
                    </td>
                    <td className="bbj-rules__pct">{pct}%</td>
                    {poolAmount > 0 && (
                      <td className="bbj-rules__money">
                        {chips(total)}
                        <span className="bbj-rules__money-sub">bad beat {chips(total * 0.5)}</span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default BBJRulesPanel;
