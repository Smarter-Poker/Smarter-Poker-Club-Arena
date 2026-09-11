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
import { getBBJMiniQualifyingInfo, BBJ_MINI_SPLIT } from '../../config/bbjMini';
import type { BbjMiniSnapshot } from '../../lib/bbjMiniFeed';
import './BBJRulesPanel.css';

/** Stakes tiers as the SERVER pays them (server/src/config/RakeConfig.ts). */
const PAYOUT_TIERS: Array<{ label: string; blinds: string; sampleBB: number }> = [
  { label: 'Nano', blinds: '0.05/0.10 - 0.10/0.20', sampleBB: 0.2 },
  { label: 'Micro', blinds: '0.20/0.40 - 0.40/0.80', sampleBB: 0.8 },
  { label: 'Small', blinds: '0.50/1 - 1.50/3', sampleBB: 3 },
  { label: 'Mid', blinds: '2/4 - 4/8', sampleBB: 8 },
  { label: 'High', blinds: '5/10 - 20/40', sampleBB: 40 },
  { label: 'Nosebleeds', blinds: '25/50+', sampleBB: 50 },
];

/** One row per distinct variant rule (aliases collapsed). */
const VARIANT_ROWS: Array<{ key: string; games: string }> = [
  { key: 'nlh', games: "No Limit / Fixed Limit Hold'em" },
  { key: 'plo4', games: 'PLO4 / FLO4' },
  { key: 'plo8', games: 'PLO8 (Hi-Lo)' },
  { key: 'plo5', games: 'PLO5 / FLO5' },
  /* Live variants that this table omitted entirely until 2026-09-11: a
     Pineapple or FLO8 player found no row describing their own game. */
  { key: 'pineapple', games: 'Pineapple' },
  { key: 'plo6', games: 'PLO6' },
  { key: 'short_deck', games: 'Short Deck' },
];

/**
 * AUDIT 2026-08-27 — four props removed, because nothing could ever pass them.
 *
 * `section`, `embedded`, `highlightVariantKey` and `highlightBB` were declared
 * here and never supplied by any caller: the sole call site is the jackpot page
 * (`<BBJRulesPanel poolAmount={...} />`), and the BBJ modal, which is the one
 * surface that HAS table context, renders `BBJBasicPanel` and
 * `BBJQualifyingHands` instead - those two take `highlightBB` and
 * `highlightVariantKey` and are already wired to it.
 *
 * So every branch they gated was unreachable: the single-section render, the
 * `bbj-rules--embedded` class and its two CSS rules, the variant-alias
 * collapsing, and both YOUR GAME / YOUR STAKES markers. Dead configuration on a
 * rules panel is worse than dead code elsewhere - the next person to want the
 * highlight would have wired it here and watched nothing happen.
 */
export interface BBJRulesPanelProps {
  /** Live main pool, so the payout table can show real chip figures. */
  poolAmount?: number;
  /**
   * The mini jackpot (lib/bbjMiniFeed). When given, the panel gains a third
   * tab, "Mini Jackpot": its bar per game and its flat amount per stakes.
   * Dan 2026-09-09: the mini is seen and discoverable wherever the main is.
   */
  mini?: BbjMiniSnapshot | null;
}

function chips(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

type RulesTab = 'qualifying' | 'payout' | 'mini';

export function BBJRulesPanel({ poolAmount = 0, mini = null }: BBJRulesPanelProps) {
  const [tab, setTab] = useState<RulesTab>('qualifying');
  const active = tab;
  const tabs: RulesTab[] = mini ? ['qualifying', 'payout', 'mini'] : ['qualifying', 'payout'];
  const miniTiers = mini ? [...mini.tiers].sort((a, b) => a.maxBB - b.maxBB) : [];

  return (
    <div className="bbj-rules">
      {
        <div
          className="bbj-rules__tabs"
          role="tablist"
          aria-label="Jackpot Rules"
          onKeyDown={(e) => {
            // Half a tablist is worse than none: a reader announced "tab 1 of 2"
            // and the arrow keys did nothing.
            const i = tabs.indexOf(tab);
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              setTab(tabs[(i - 1 + tabs.length) % tabs.length]);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              setTab(tabs[(i + 1) % tabs.length]);
            } else if (e.key === 'Home') {
              e.preventDefault();
              setTab(tabs[0]);
            } else if (e.key === 'End') {
              e.preventDefault();
              setTab(tabs[tabs.length - 1]);
            }
          }}
        >
          <button
            role="tab"
            id="bbj-rules-tab-qualifying"
            aria-selected={tab === 'qualifying'}
            aria-controls="bbj-rules-panel"
            tabIndex={tab === 'qualifying' ? 0 : -1}
            className={`bbj-rules__tab${tab === 'qualifying' ? ' is-active' : ''}`}
            onClick={() => setTab('qualifying')}
          >
            What Qualifies
          </button>
          <button
            role="tab"
            id="bbj-rules-tab-payout"
            aria-selected={tab === 'payout'}
            aria-controls="bbj-rules-panel"
            tabIndex={tab === 'payout' ? 0 : -1}
            className={`bbj-rules__tab${tab === 'payout' ? ' is-active' : ''}`}
            onClick={() => setTab('payout')}
          >
            What It Pays
          </button>
          {mini && (
            <button
              role="tab"
              id="bbj-rules-tab-mini"
              aria-selected={tab === 'mini'}
              aria-controls="bbj-rules-panel"
              tabIndex={tab === 'mini' ? 0 : -1}
              className={`bbj-rules__tab${tab === 'mini' ? ' is-active' : ''}`}
              onClick={() => setTab('mini')}
            >
              Mini Jackpot
            </button>
          )}
        </div>
      }

      {active === 'mini' && mini && (
        <div
          className="bbj-rules__body"
          id="bbj-rules-panel"
          role="tabpanel"
          aria-labelledby="bbj-rules-tab-mini"
          tabIndex={0}
        >
          <p className="bbj-rules__note">
            The Mini Jackpot Pays A Flat Amount, By The Stakes You Were Playing, For The Bad Beats
            The Main Rule Turns Away: Aces Full Or Better Losing To Quads Or Better In Hold’em, Any
            Quads Losing To Bigger Quads Or Better In Omaha. The Winner Must Still Hold Quads Or
            Better; The Same Pot, Player And Board Conditions Apply. It Is Paid From The Backup Pool
            And Pauses While That Reserve Is At Its Floor. One Hand Pays One Jackpot, Never Both.
          </p>

          <table className="bbj-rules__table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Losing Hand Must Be</th>
              </tr>
            </thead>
            <tbody>
              {VARIANT_ROWS.map((row) => {
                const info = getBBJMiniQualifyingInfo(row.key);
                return (
                  <tr key={row.key} className={info.eligible ? '' : 'is-ineligible'}>
                    <td>{row.games}</td>
                    <td>{info.eligible ? info.shortLabel : 'Mini Not Available'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!mini.enabled ? (
            <p className="bbj-rules__note">The Mini Jackpot Is Switched Off For This Jackpot.</p>
          ) : (
            <table className="bbj-rules__table">
              <thead>
                <tr>
                  <th>Stakes</th>
                  <th>Mini Pays</th>
                  <th>Right Now</th>
                </tr>
              </thead>
              <tbody>
                {miniTiers.map((t) => (
                  <tr key={t.tierId} className={t.enabled ? '' : 'is-ineligible'}>
                    <td>
                      <span className="bbj-rules__tier">{t.label}</span>
                      <span className="bbj-rules__blinds">{t.blindRange}</span>
                    </td>
                    <td className="bbj-rules__money">
                      {chips(t.amount)}
                      <span className="bbj-rules__money-sub">
                        Bad Beat {chips(t.amount * BBJ_MINI_SPLIT.loser)}
                      </span>
                    </td>
                    <td className="bbj-rules__pct">
                      {t.enabled ? (t.payable ? 'Pays' : 'Paused') : 'Off'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <ul className="bbj-rules__list">
            <li>
              Split Like The Main Jackpot: 50% To The Bad-Beat Hand, 25% To The Hand That Won, 25%
              Between Everyone Else Dealt In
            </li>
            <li>
              Reserve Floor: {chips(mini.reserveFloor)} Chips Stay In The Backup Pool; A Mini That
              Would Take It Below That Is Not Paid
            </li>
            <li>
              Last 30 Days: {mini.hits30d.toLocaleString('en-US')} Mini{' '}
              {mini.hits30d === 1 ? 'Jackpot' : 'Jackpots'}, {chips(mini.paid30d)} Chips Paid
            </li>
          </ul>
        </div>
      )}

      {active === 'qualifying' && (
        <div
          className="bbj-rules__body"
          id="bbj-rules-panel"
          role="tabpanel"
          aria-labelledby="bbj-rules-tab-qualifying"
          tabIndex={0}
        >
          <table className="bbj-rules__table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Losing Hand Must Be</th>
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
                    <td>{eligible ? info.shortLabel : 'Jackpot Not Available'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="bbj-rules__list">
            <li>Drop Collected On Every Flop With {BBJ_RULES.minPlayersDealt}+ Players Dealt In</li>
            <li>Minimum Pot To Win The Jackpot: {BBJ_RULES.minPotBB} Big Blinds</li>
            <li>Minimum Players Dealt In: {BBJ_RULES.minPlayersDealt}</li>
            {BBJ_RULES.requireBothHoleCards && (
              <li>
                Both Hole Cards Must Play (In Omaha Games, Exactly Two) - For Both The Losing And
                The Winning Hand
              </li>
            )}
            {BBJ_RULES.onlyFirstRunout && (
              <li>When A Pot Is Run Twice Or Three Times, Only The FIRST Board Can Trigger It</li>
            )}
          </ul>
        </div>
      )}

      {active === 'payout' && (
        <div
          className="bbj-rules__body"
          id="bbj-rules-panel"
          role="tabpanel"
          aria-labelledby="bbj-rules-tab-payout"
          tabIndex={0}
        >
          <p className="bbj-rules__note">
            A Jackpot Hit Pays A Share Of The Main Pool Set By The Stakes You Were Playing - Not The
            Whole Pool. That Share Is Then Split 50% To The Bad-Beat Hand, 25% To The Hand That Won,
            And 25% Between Everyone Else Dealt Into The Hand.
          </p>

          <table className="bbj-rules__table">
            <thead>
              <tr>
                <th>Stakes</th>
                <th>Pays</th>
                {poolAmount > 0 && <th>At Today&rsquo;S Pool</th>}
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
                        <span className="bbj-rules__money-sub">Bad Beat {chips(total * 0.5)}</span>
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
