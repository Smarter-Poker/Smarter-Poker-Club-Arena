/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ BASIC — the rules, the fee, and what each stake pays
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The middle tab of the jackpot popup: the qualifying conditions in one
 * paragraph, then one row per stakes tier showing what the hand is charged and
 * how a hit is split.
 *
 * EVERY NUMBER IS DERIVED, NOT TYPED. The tiers are grouped by the payout
 * percentages the server actually pays (getBBJPayoutPercentForBB), and the fee
 * column is read out of the same RAKE_SCHEDULE the engine charges from. A
 * hand-written table here drifted from the engine once already; this one cannot,
 * because there is nothing to keep in sync.
 *
 * Note the fee and payout ladders do NOT share boundaries — a payout tier can
 * span two fee rows — so the fee column prints a range whenever it varies inside
 * a tier rather than quietly showing one of the two.
 */

import { useMemo } from 'react';
import {
  BBJ_RULES,
  RAKE_SCHEDULE,
  STAKES_TIERS,
  getBBJPayoutPercentForBB,
} from '../../config/RakeConfig';
import './BBJBasicPanel.css';

export interface BBJBasicPanelProps {
  /** Live main pool, so each row can show what it would pay today. */
  poolAmount?: number;
  /** Big blind of the table the player is sitting at — its row is marked. */
  highlightBB?: number | null;
}

interface TierRow {
  pct: number;
  label: string;
  blinds: string;
  fee: string;
}

/** Human label for each payout percent, matching the published stakes names. */
const PCT_LABEL: Record<number, string> = {
  15: 'Nano',
  25: 'Micro',
  40: 'Small',
  55: 'Mid',
  70: 'High',
  85: 'Nosebleeds',
};

function trimNum(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function chips(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Group the published rake schedule by the payout percent the server pays at
 * that big blind, then describe each group's blind range and BBJ fee.
 */
function buildTiers(): TierRow[] {
  const groups = new Map<number, { sb: number; bb: number; fee: number }[]>();
  RAKE_SCHEDULE.forEach((row) => {
    const pct = getBBJPayoutPercentForBB(row.bb);
    const list = groups.get(pct) || [];
    list.push({ sb: row.sb, bb: row.bb, fee: row.bbjFeeBB });
    groups.set(pct, list);
  });

  const rows: TierRow[] = [];
  Object.keys(PCT_LABEL)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((pct) => {
      const list = groups.get(pct);
      if (!list || list.length === 0) {
        // Nosebleeds have no exact schedule row — the engine falls back to the
        // tier table for them, so read the fee from there instead of guessing.
        if (pct === 85) {
          rows.push({
            pct,
            label: PCT_LABEL[pct],
            blinds: STAKES_TIERS.nosebleeds.blindRange,
            fee: `${trimNum(STAKES_TIERS.nosebleeds.bbjFeeBB)} bb`,
          });
        }
        return;
      }
      const sorted = [...list].sort((a, b) => a.bb - b.bb);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const fees = [...new Set(sorted.map((r) => r.fee))].sort((a, b) => a - b);
      rows.push({
        pct,
        label: PCT_LABEL[pct],
        blinds:
          lo.bb === hi.bb
            ? `${trimNum(lo.sb)}/${trimNum(lo.bb)}`
            : `${trimNum(lo.sb)}/${trimNum(lo.bb)} - ${trimNum(hi.sb)}/${trimNum(hi.bb)}`,
        fee:
          fees.length === 1
            ? `${trimNum(fees[0])} bb`
            : `${trimNum(fees[0])} - ${trimNum(fees[fees.length - 1])} bb`,
      });
    });

  return rows;
}

export function BBJBasicPanel({ poolAmount = 0, highlightBB = null }: BBJBasicPanelProps) {
  const tiers = useMemo(buildTiers, []);
  const hlPct = typeof highlightBB === 'number' && highlightBB > 0
    ? getBBJPayoutPercentForBB(highlightBB)
    : null;

  return (
    <div className="bbj-basic">
      <p className="bbj-basic__rules">
        The pot must be at least {BBJ_RULES.minPotBB} big blinds and{' '}
        {BBJ_RULES.minPlayersDealt} players must be dealt in preflop.
        {BBJ_RULES.requireBothHoleCards
          ? ' Both hole cards must play, for the losing hand and the winning hand.'
          : ''}
        {BBJ_RULES.onlyFirstRunout
          ? ' When a pot is run more than once, only the first runout counts.'
          : ''}
        {BBJ_RULES.excludeDoubleBoard
          ? ' The Bad Beat Jackpot is not available on double and triple board games.'
          : ''}
      </p>

      <div className="bbj-basic__scroll">
        <table className="bbj-basic__table">
          <thead>
            <tr>
              <th>Stakes</th>
              <th>Blinds</th>
              <th>Fee</th>
              <th>
                Payout
                <span className="bbj-basic__subhead">Bad beat / Winner / Table / Total</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => {
              const isHere = hlPct !== null && hlPct === t.pct;
              const total = (poolAmount * t.pct) / 100;
              return (
                <tr key={t.pct} className={isHere ? 'is-current' : ''}>
                  <td>
                    <span className="bbj-basic__tier">{t.label}</span>
                    {isHere && <span className="bbj-basic__here">YOUR STAKES</span>}
                  </td>
                  <td className="bbj-basic__blinds">{t.blinds}</td>
                  <td className="bbj-basic__fee">{t.fee}</td>
                  <td className="bbj-basic__pay">
                    <span className="bbj-basic__pcts">
                      {trimNum(t.pct * 0.5)}% / {trimNum(t.pct * 0.25)}% /{' '}
                      {trimNum(t.pct * 0.25)}% / {t.pct}%
                    </span>
                    {poolAmount > 0 && (
                      <span className="bbj-basic__today">{chips(total)} today</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="bbj-basic__note">
        The fee is taken from the pot, not from your stack, and only on hands that meet the
        conditions above. A hit pays the share of the main pool set by the stakes you were playing,
        never the whole pool.
      </p>
    </div>
  );
}

export default BBJBasicPanel;
