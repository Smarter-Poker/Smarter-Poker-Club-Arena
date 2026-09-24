/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GAME RULES MODAL - Table Rules, Limits and Hand Rankings, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSOLE (2026-09-08). This was a rounded navy sheet with a gradient
 * header, an information glyph stuck beside the title, a square close button,
 * an underlined tab bar and every value boxed in its own rounded card - a
 * generic reference sheet dressed as a popup. It is now Dan's approved spade
 * master, the same one every Omaha card is drawn from: the stakes are the
 * eyebrow, "<VARIANT> RULES" is engraved in the header well, the table type
 * sits in the well's painted pill slot, the four tabs and every row print on
 * the black glass between the rails, and the two actions are the plates
 * painted into the foot. Rows are separated by an engraved rule, never by a
 * drawn card; nothing here has a border-radius, a gradient or a fill.
 *
 * The three house-law sentences (chip continuity, OPORD 1.3 section 6.1) are
 * pinned verbatim by tests/chip-continuity-is-house-law.law.test.ts and are
 * unchanged. So is the Table Info tab's own gate - one token in that tab's
 * className made the whole tab unreachable in production once already
 * (tests/unit/bombPotGuards.test.ts).
 */

import React, { useState, useEffect } from 'react';
import './GameRulesModal.css';
import { SpadeConsole } from '../console/SpadeConsole';
import { CardImage } from './CardImage';
import { bettingStructureFor } from '../../lib/bettingStructure';
import { holeCardCountFor } from '../../lib/holeCardCount';
import { killPotName, killRuleRows, type KillTableRule } from '../../utils/killPot';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableRule {
  label: string;
  value: string;
  description?: string;
}

export interface GameRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  variant: string;
  stakes: string;
  minBuyIn: number;
  maxBuyIn: number;
  rakePercentage?: number;
  rakeCap?: number;
  isStraddleEnabled?: boolean;
  isRunItTwiceEnabled?: boolean;
  isInsuranceEnabled?: boolean;
  ante?: number;
  currency?: string;
  customRules?: TableRule[];
  /**
   * CHIP CONTINUITY (2026-09-04): cash tables carry three house-law sentences
   * (OPORD 1.3 section 6.1). A tournament table shows none of them.
   */
  isCashTable?: boolean;
  bombPotRules?: {
    enabled: boolean;
    frequency: number;
    anteBB: number;
    doubleBoard: boolean;
    /** BOMB POT STANDARDIZATION 2026-08-27: boards per bomb hand (1-3). */
    boardCount?: number;
    /** 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only' */
    triggerMode?: string;
    /** Timed mode: seconds between bombs. */
    intervalSeconds?: number;
    /** VARIANT OVERRIDE (spec §10.1): bomb hand variant; null = same as table. */
    variant?: string | null;
    /** ANNOUNCE WINDOW (spec §3): clock shows within this many seconds. */
    announceSeconds?: number;
    /** FIXED ANTE in chips (2026-08-29). Beats anteBB whenever above zero. */
    anteFixed?: number;
    /** Seats required before the engine will fire a bomb (2026-08-29). */
    minPlayers?: number;
    /** 'regular' | 'separate' (2026-08-29). */
    buttonPolicy?: string;
  } | null;
  /**
   * MANUAL_NEXT_HAND (spec §2.1/§15.3): drawn only for club staff. The RPC
   * behind onManualBombPot re-checks the role and writes the audit row.
   */
  canManualBombPot?: boolean;
  onManualBombPot?: () => void;
  /**
   * 2026-08-29: club staff can edit the bomb rules of a table that is already
   * running. Until now every bomb setting was write-once — the only way to
   * change one was to kill the table and lose its seated players.
   */
  canEditBombSettings?: boolean;
  onEditBombSettings?: () => void;
  /**
   * KILL POTS (rule manifest kill-v1): the table's kill rule, read from its
   * own row. Null when the table runs none or the read could not say, and
   * then nothing about kills is printed.
   */
  killPotRules?: KillTableRule | null;
}

type TabType = 'info' | 'rules' | 'limits' | 'rankings';

// ═══════════════════════════════════════════════════════════════════════════════
// HAND RANKINGS DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const STANDARD_HANDS = [
  {
    name: 'Royal Flush',
    desc: 'Five sequential cards of the same suit. The highest straight flush is T-J-Q-K-A, same suit.',
    cards: [
      { rank: 'A' as const, suit: 's' as const },
      { rank: 'K' as const, suit: 's' as const },
      { rank: 'Q' as const, suit: 's' as const },
      { rank: 'J' as const, suit: 's' as const },
      { rank: 'T' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Straight Flush',
    desc: 'Five sequential cards of the same suit.',
    cards: [
      { rank: 'T' as const, suit: 'h' as const },
      { rank: '9' as const, suit: 'h' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '7' as const, suit: 'h' as const },
      { rank: '6' as const, suit: 'h' as const },
    ],
  },
  {
    name: 'Four of a Kind / Quad',
    desc: 'Four cards of the same rank.',
    cards: [
      { rank: 'T' as const, suit: 's' as const },
      { rank: 'T' as const, suit: 'h' as const },
      { rank: 'T' as const, suit: 'c' as const },
      { rank: 'T' as const, suit: 'd' as const },
      { rank: '4' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Full House',
    desc: 'Three of a kind plus a pair.',
    cards: [
      { rank: 'Q' as const, suit: 's' as const },
      { rank: 'Q' as const, suit: 'd' as const },
      { rank: 'Q' as const, suit: 'c' as const },
      { rank: 'J' as const, suit: 'd' as const },
      { rank: 'J' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'Flush',
    desc: 'Five non-sequential cards of the same suit.',
    cards: [
      { rank: 'A' as const, suit: 'c' as const },
      { rank: 'K' as const, suit: 'c' as const },
      { rank: '5' as const, suit: 'c' as const },
      { rank: '4' as const, suit: 'c' as const },
      { rank: '3' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'Straight',
    desc: 'Five sequential cards of mixed suits.',
    cards: [
      { rank: '9' as const, suit: 's' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '7' as const, suit: 'd' as const },
      { rank: '6' as const, suit: 'c' as const },
      { rank: '5' as const, suit: 'h' as const },
    ],
  },
  {
    name: 'Three of a Kind',
    desc: 'Three cards of the same rank.',
    cards: [
      { rank: '7' as const, suit: 'c' as const },
      { rank: '7' as const, suit: 's' as const },
      { rank: '7' as const, suit: 'h' as const },
      { rank: 'K' as const, suit: 'd' as const },
      { rank: '2' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Two Pair',
    desc: 'Two different pairs of cards.',
    cards: [
      { rank: 'J' as const, suit: 'h' as const },
      { rank: 'J' as const, suit: 's' as const },
      { rank: '4' as const, suit: 'c' as const },
      { rank: '4' as const, suit: 'd' as const },
      { rank: '9' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'One Pair',
    desc: 'Two cards of the same rank.',
    cards: [
      { rank: 'A' as const, suit: 'd' as const },
      { rank: 'A' as const, suit: 'c' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '6' as const, suit: 's' as const },
      { rank: '3' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'High Card',
    desc: 'No made hand, ranked by the highest single card.',
    cards: [
      { rank: 'A' as const, suit: 'h' as const },
      { rank: 'J' as const, suit: 'd' as const },
      { rank: '9' as const, suit: 's' as const },
      { rank: '5' as const, suit: 'c' as const },
      { rank: '2' as const, suit: 'h' as const },
    ],
  },
];

const SHORT_DECK_HANDS = [
  {
    name: 'Royal Flush',
    desc: 'Five sequential cards of the same suit. The highest straight flush is T-J-Q-K-A, same suit.',
    cards: [
      { rank: 'A' as const, suit: 's' as const },
      { rank: 'K' as const, suit: 's' as const },
      { rank: 'Q' as const, suit: 's' as const },
      { rank: 'J' as const, suit: 's' as const },
      { rank: 'T' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Straight Flush',
    desc: 'Five sequential cards of the same suit.',
    cards: [
      { rank: 'J' as const, suit: 'h' as const },
      { rank: 'T' as const, suit: 'h' as const },
      { rank: '9' as const, suit: 'h' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '7' as const, suit: 'h' as const },
    ],
  },
  {
    name: 'Four of a Kind / Quad',
    desc: 'Four cards of the same rank.',
    cards: [
      { rank: 'T' as const, suit: 's' as const },
      { rank: 'T' as const, suit: 'h' as const },
      { rank: 'T' as const, suit: 'c' as const },
      { rank: 'T' as const, suit: 'd' as const },
      { rank: '6' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Flush',
    desc: 'Five non-sequential cards of the same suit.',
    cards: [
      { rank: 'A' as const, suit: 'c' as const },
      { rank: 'K' as const, suit: 'c' as const },
      { rank: 'J' as const, suit: 'c' as const },
      { rank: '8' as const, suit: 'c' as const },
      { rank: '6' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'Full House',
    desc: 'Three of a kind plus a pair.',
    cards: [
      { rank: 'Q' as const, suit: 's' as const },
      { rank: 'Q' as const, suit: 'd' as const },
      { rank: 'Q' as const, suit: 'c' as const },
      { rank: 'J' as const, suit: 'd' as const },
      { rank: 'J' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'Straight',
    desc: 'Five sequential cards of mixed suits (A-6-7-8-9 is the lowest straight).',
    cards: [
      { rank: '9' as const, suit: 's' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '7' as const, suit: 'd' as const },
      { rank: '6' as const, suit: 'c' as const },
      { rank: 'A' as const, suit: 'h' as const },
    ],
  },
  {
    name: 'Three of a Kind',
    desc: 'Three cards of the same rank.',
    cards: [
      { rank: '7' as const, suit: 'c' as const },
      { rank: '7' as const, suit: 's' as const },
      { rank: '7' as const, suit: 'h' as const },
      { rank: 'K' as const, suit: 'd' as const },
      { rank: '8' as const, suit: 's' as const },
    ],
  },
  {
    name: 'Two Pair',
    desc: 'Two different pairs of cards.',
    cards: [
      { rank: 'J' as const, suit: 'h' as const },
      { rank: 'J' as const, suit: 's' as const },
      { rank: '8' as const, suit: 'c' as const },
      { rank: '8' as const, suit: 'd' as const },
      { rank: '9' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'One Pair',
    desc: 'Two cards of the same rank.',
    cards: [
      { rank: 'A' as const, suit: 'd' as const },
      { rank: 'A' as const, suit: 'c' as const },
      { rank: '8' as const, suit: 'h' as const },
      { rank: '7' as const, suit: 's' as const },
      { rank: '6' as const, suit: 'c' as const },
    ],
  },
  {
    name: 'High Card',
    desc: 'No made hand, ranked by the highest single card.',
    cards: [
      { rank: 'A' as const, suit: 'h' as const },
      { rank: 'J' as const, suit: 'd' as const },
      { rank: '9' as const, suit: 's' as const },
      { rank: '7' as const, suit: 'c' as const },
      { rank: '6' as const, suit: 'h' as const },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function GameRulesModal({
  isOpen,
  onClose,
  variant,
  stakes,
  minBuyIn,
  maxBuyIn,
  rakePercentage,
  rakeCap,
  isStraddleEnabled = false,
  isRunItTwiceEnabled = false,
  isInsuranceEnabled = false,
  ante = 0,
  currency = '',
  customRules = [],
  isCashTable = false,
  bombPotRules = null,
  canManualBombPot = false,
  onManualBombPot,
  canEditBombSettings = false,
  onEditBombSettings,
  killPotRules = null,
}: GameRulesModalProps) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('rules');

  // TablePage supplies canonical codes; retain the existing display-label aliases.
  const vUpper = (variant || '').trim().toUpperCase();
  const isOmaha = vUpper === 'FLO8' || vUpper.includes('PLO') || vUpper.includes('OMAHA');
  const isHiLo = isOmaha && (vUpper.endsWith('8') || /HI[ -]?LO|8 OR BETTER/.test(vUpper));
  const isPineapple = vUpper.includes('PINEAPPLE');
  const isShortDeck = /SHORT[ _-]DECK|6\+/.test(vUpper);
  const structure = bettingStructureFor(vUpper);
  const isFixedLimit = structure === 'fixed_limit' || vUpper.includes('FIXED LIMIT');
  const isPotLimit = !isFixedLimit && (structure === 'pot_limit' || vUpper.includes('POT LIMIT'));
  const holeCards = isOmaha
    ? Math.max(
        4,
        holeCardCountFor(vUpper),
        Number(vUpper.match(/(?:PLO|OMAHA)\s*([456])\b/)?.[1] ?? 0)
      )
    : holeCardCountFor(vUpper);

  useEffect(() => {
    if (isOpen) {
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
      setTimeout(() => setActiveTab('rules'), 400); // reset tab on close
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="rules-overlay" onClick={onClose}>
      <div
        className="rules-modal ac-popup"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-modal-title"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.98)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <SpadeConsole
          as="div"
          eyebrow={stakes}
          title={`${variant} Rules`}
          titleId="rules-modal-title"
          /* The table type in the well's painted pill slot: a cash seat
             carries the stay clock and the return floor, a tournament seat
             carries neither, and the House Rules block below follows the
             same flag. */
          pill={isCashTable ? 'Cash' : 'Event'}
          plates={{
            secondary: {
              label: 'Close',
              onClick: onClose,
              'aria-label': 'Close Table Rules',
            },
            /* The steel plate closes; the blue glass carries the page a
               player opens this sheet for more than any other. The staff
               controls stay in the Table Info tab beside the bomb settings
               they act on, so a forced ante is never armed from two
               places. */
            primary: {
              label: 'Hand Ranking',
              ink: 'white' as const,
              onClick: () => setActiveTab('rankings'),
              'aria-label': 'Show The Hand Rankings',
            },
          }}
        >
          {/* Tab Navigation */}
          <div className="rules-modal__tabs">
            {/*
            2026-08-29: this button set activeTab to 'rules'. Nothing anywhere
            set it to 'info', so `{activeTab === 'info' && ...}` below never
            rendered and the ENTIRE Table Info tab was unreachable in
            production: the financials, the feature chips, the whole Bomb Pot
            disclosure block (schedule, ante, boards, played-as variant), and
            the host's "Bomb Pot Next Hand" button.

            That last one is why this one token mattered. The manual-bomb path
            is fully built end to end — fn_request_manual_bomb_pot, the
            bomb_pot_manual_requests audit trail, the bomb_pot_manual_pending
            column, the engine's per-hand read of it, the staff role check and
            the toast — and the only control that reaches any of it is inside
            this tab. A club owner could not fire a manual bomb pot at all, and
            no player could read the bomb rules from inside the table.
          */}
            <button
              className={`rules-modal__tab ${activeTab === 'info' ? 'rules-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('info')}
            >
              Table Info
            </button>
            <button
              className={`rules-modal__tab ${activeTab === 'rules' ? 'rules-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('rules')}
            >
              Rules
            </button>
            <button
              className={`rules-modal__tab ${activeTab === 'limits' ? 'rules-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('limits')}
            >
              Betting Limits
            </button>
            <button
              className={`rules-modal__tab ${activeTab === 'rankings' ? 'rules-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('rankings')}
            >
              Hand Ranking
            </button>
          </div>

          <div className="rules-modal__content-area">
            {/* ────────────────────────────────────────────────────────────────────────
              TAB 1: TABLE INFO (The original modal content)
              ──────────────────────────────────────────────────────────────────────── */}
            {activeTab === 'info' && (
              <div className="rules-modal__content">
                {/* Financials Section */}
                <div className="rules-modal__section">
                  <h3 className="rules-modal__section-title">Financials</h3>
                  <div className="rules-modal__grid">
                    <div className="rules-modal__item">
                      <span className="rules-modal__label">Blinds</span>
                      <span className="rules-modal__value">{stakes}</span>
                    </div>
                    {ante > 0 && (
                      <div className="rules-modal__item">
                        <span className="rules-modal__label">Ante</span>
                        <span className="rules-modal__value">
                          {currency}
                          {ante}
                        </span>
                      </div>
                    )}
                    <div className="rules-modal__item">
                      <span className="rules-modal__label">Min Buy-In</span>
                      <span className="rules-modal__value">
                        {currency}
                        {minBuyIn.toLocaleString()}
                      </span>
                    </div>
                    <div className="rules-modal__item">
                      <span className="rules-modal__label">Max Buy-In</span>
                      <span className="rules-modal__value">
                        {currency}
                        {maxBuyIn.toLocaleString()}
                      </span>
                    </div>
                    <div className="rules-modal__item">
                      <span className="rules-modal__label">Rake</span>
                      <span className="rules-modal__value">
                        {rakePercentage === undefined || rakeCap === undefined
                          ? '-'
                          : `${rakePercentage}% (Cap ${currency}${rakeCap})`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Features Section */}
                <div className="rules-modal__section">
                  <h3 className="rules-modal__section-title">Table Features</h3>
                  <div className="rules-modal__features">
                    <div
                      className={`rules-modal__feature ${isStraddleEnabled ? 'rules-modal__feature--active sc-ink--green' : 'sc-ink--muted'}`}
                    >
                      <span className="rules-modal__feature-text">Straddle</span>
                    </div>
                    <div
                      className={`rules-modal__feature ${isRunItTwiceEnabled ? 'rules-modal__feature--active sc-ink--green' : 'sc-ink--muted'}`}
                    >
                      <span className="rules-modal__feature-text">Run It Twice</span>
                    </div>
                    <div
                      className={`rules-modal__feature ${isInsuranceEnabled ? 'rules-modal__feature--active sc-ink--green' : 'sc-ink--muted'}`}
                    >
                      <span className="rules-modal__feature-text">Insurance</span>
                    </div>
                    <div
                      className={`rules-modal__feature ${bombPotRules?.enabled ? 'rules-modal__feature--active' : ''}`}
                    >
                      <span className="rules-modal__feature-text">
                        {/* Two boards is the default every bomb pot runs, so the
                          headline just says Bomb Pot (Dan 2026-09-07, item
                          7D). Three is a departure and keeps its name. The
                          exact count is still spelled out in the Boards row
                          of the section below, where a player who wants the
                          number goes looking for it. */}
                        {(bombPotRules?.boardCount ?? 0) >= 3
                          ? 'Triple Board Bomb Pot'
                          : 'Bomb Pot'}
                      </span>
                    </div>
                  </div>
                </div>

                {bombPotRules?.enabled && (
                  <div className="rules-modal__section">
                    <h3 className="rules-modal__section-title">Bomb Pot</h3>
                    <div className="rules-modal__grid">
                      <div className="rules-modal__item">
                        <span className="rules-modal__label">
                          {/* BOMB POT STANDARDIZATION 2026-08-27 (spec §15):
                            the schedule line names the trigger mode. */}
                          {bombPotRules.triggerMode === 'once_per_orbit' ||
                          bombPotRules.triggerMode === 'timed' ||
                          bombPotRules.triggerMode === 'bomb_pot_only'
                            ? 'Schedule'
                            : 'Every'}
                        </span>
                        <span className="rules-modal__value">
                          {bombPotRules.triggerMode === 'once_per_orbit'
                            ? 'Once Per Orbit'
                            : bombPotRules.triggerMode === 'timed'
                              ? (bombPotRules.intervalSeconds ?? 0) > 0
                                ? `Every ${Math.round((bombPotRules.intervalSeconds ?? 0) / 60)} Min`
                                : 'Timed'
                              : bombPotRules.triggerMode === 'bomb_pot_only'
                                ? 'Every Hand'
                                : bombPotRules.frequency > 0
                                  ? `${bombPotRules.frequency} Hands`
                                  : '-'}
                        </span>
                      </div>
                      <div className="rules-modal__item">
                        <span className="rules-modal__label">Ante</span>
                        <span className="rules-modal__value">
                          {/* FIXED ANTE 2026-08-29: the engine prefers the fixed
                            amount whenever it is above zero, and the config
                            form writes the BB multiplier in BOTH modes — so
                            reading the multiplier alone described a fixed-ante
                            table with a number nobody is charged, while the
                            lobby (which reads the fixed column) said the real
                            one. Same precedence here as in the engine. */}
                          {(bombPotRules.anteFixed ?? 0) > 0
                            ? `${(bombPotRules.anteFixed ?? 0).toLocaleString()} Chips`
                            : bombPotRules.anteBB > 0
                              ? `${bombPotRules.anteBB}x BB`
                              : '-'}
                        </span>
                      </div>
                      <div className="rules-modal__item">
                        <span className="rules-modal__label">Boards</span>
                        <span className="rules-modal__value">
                          {(bombPotRules.boardCount ?? 0) >= 3
                            ? '3 (Pot Splits Per Board)'
                            : bombPotRules.doubleBoard
                              ? '2 (Pot Splits Per Board)'
                              : '1'}
                        </span>
                      </div>
                      {/* VARIANT OVERRIDE (spec §10.1): only shown when the bomb
                        hand plays a different game from the table. */}
                      {bombPotRules.variant && (
                        <div className="rules-modal__item">
                          <span className="rules-modal__label">Played As</span>
                          <span className="rules-modal__value">
                            {bombPotRules.variant.toUpperCase()}
                          </span>
                        </div>
                      )}
                      {/* MIN PLAYERS 2026-08-29. The engine holds the bomb below
                        this floor and says nothing — so a table that had been
                        promising BOMB POT NEXT HAND for twenty hands offered no
                        way to find out why it never came. Now it does. */}
                      {(bombPotRules.minPlayers ?? 0) > 2 && (
                        <div className="rules-modal__item">
                          <span className="rules-modal__label">Needs</span>
                          <span className="rules-modal__value">
                            {bombPotRules.minPlayers} Players
                          </span>
                        </div>
                      )}
                      {/* BUTTON POLICY 2026-08-29. This decides who acts last on
                        every street of a bomb hand, and a separate button moves
                        on its own rotation — visible at the felt as a button
                        that does not advance. Disclose it rather than leaving
                        the player to conclude the table is broken. */}
                      {bombPotRules.buttonPolicy === 'separate' && (
                        <div className="rules-modal__item">
                          <span className="rules-modal__label">Button</span>
                          <span className="rules-modal__value">Separate Bomb Button</span>
                        </div>
                      )}
                    </div>
                    {/* MANUAL_NEXT_HAND (spec §2.1/§15.3): club staff only.
                      The RPC re-checks the role and logs the request — this
                      button is presentation, never the gate. */}
                    {canManualBombPot && onManualBombPot && (
                      <button
                        type="button"
                        className="rules-modal__manual-bomb"
                        onClick={onManualBombPot}
                      >
                        Bomb Pot Next Hand
                      </button>
                    )}
                    {/* EDIT THE RUNNING TABLE (2026-08-29). Same staff gate, and
                      the RPC behind it re-checks the role anyway. Drawn here
                      because this is where a host already comes to act on bomb
                      pots, and because the panel above is exactly the list of
                      values they are about to change. */}
                    {canEditBombSettings && onEditBombSettings && (
                      <button
                        type="button"
                        className="rules-modal__edit-bomb"
                        onClick={onEditBombSettings}
                      >
                        Edit Bomb Pot Settings
                      </button>
                    )}
                  </div>
                )}

                {/* KILL POTS (kill-v1): only on a table that runs them. */}
                {isFixedLimit && killPotRules && (
                  <div className="rules-modal__section">
                    <h3 className="rules-modal__section-title">{killPotName(killPotRules.mode)}</h3>
                    <div className="rules-modal__grid">
                      {killRuleRows(killPotRules).map((r) => (
                        <div className="rules-modal__item" key={r.label}>
                          <span className="rules-modal__label">{r.label}</span>
                          <span className="rules-modal__value">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CHIP CONTINUITY - the only three sentences allowed (s6.1) */}
                {isCashTable && (
                  <div className="rules-modal__section">
                    <h3 className="rules-modal__section-title">House Rules</h3>
                    <ul className="rules-modal__bullet-list">
                      <li>Chips On The Table Stay On The Table Until You Leave.</li>
                      <li>
                        If You Are Ahead Of The Money You Put In, You Remain Seated For 10 Minutes
                        Before You Can Leave.
                      </li>
                      <li>
                        If You Return To The Same Game In This Club Within 2 Hours, You Buy In For
                        At Least The Stack You Left With.
                      </li>
                    </ul>
                  </div>
                )}

                {/* Custom Rules Section */}
                {customRules.length > 0 && (
                  <div className="rules-modal__section">
                    <h3 className="rules-modal__section-title">House Rules</h3>
                    <div className="rules-modal__custom-list">
                      {customRules.map((rule, idx) => (
                        <div key={idx} className="rules-modal__custom-item">
                          <div className="rules-modal__custom-header">
                            <span className="rules-modal__custom-label">{rule.label}</span>
                            <span className="rules-modal__custom-value">{rule.value}</span>
                          </div>
                          {rule.description && (
                            <p className="rules-modal__custom-desc">{rule.description}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ────────────────────────────────────────────────────────────────────────
              TAB 2: RULES (Dynamic per variant)
              ──────────────────────────────────────────────────────────────────────── */}
            {activeTab === 'rules' && (
              <div className="rules-modal__content">
                <ul className="rules-modal__bullet-list">
                  {isOmaha ? (
                    <>
                      <li>
                        Omaha Poker Hands Are Always Formed Of <strong>Five Cards</strong>. Unlike
                        In Hold'em, Players Must Use <strong>Exactly Two</strong> From Their Hand
                        And <strong>Exactly Three</strong> From The Community Cards To Form Their
                        Five-Card Hand.
                      </li>
                      <li>
                        In This Variant, Each Player Receives {holeCards} Face Down ("Hole") Cards
                        Before Any Betting Begins.
                      </li>
                      <li>
                        There Follow Up To Four <strong>Betting Rounds</strong> During Which Players
                        Act In Turn To Check, Bet, Call, Or Fold.{' '}
                        <strong>Five Community Cards</strong> Are Dealt - A "Flop" Of Three, "Turn"
                        Of One, And "River" Of One.
                      </li>
                      <li>
                        At The End Of The Betting Rounds, Remaining Players Use A Combination Of{' '}
                        <strong>Exactly Two Of Their Hole Cards</strong> And{' '}
                        <strong>Exactly Three Community Cards</strong> To Form The Best Poker Hand.
                      </li>
                    </>
                  ) : isPineapple ? (
                    <>
                      <li>
                        Pineapple Poker Hands Are Formed By Combining Your Hole Cards And The
                        Community Cards To Make The Best 5-Card Hand.
                      </li>
                      <li>
                        Each Player Is Initially Dealt <strong>Three Hole Cards</strong> Face Down.
                      </li>
                      <li>
                        This Table Plays Crazy Pineapple. Players{' '}
                        <strong>Discard One Hole Card</strong> After Flop Betting And Before The
                        Turn. If Betting Ends All-In Earlier, The Discard Happens After The Flop Is
                        Dealt And Before Any Further Board Cards.
                      </li>
                      <li>
                        After The Discard, The Hand Proceeds Identically To Standard Texas Hold'em.
                      </li>
                    </>
                  ) : isShortDeck ? (
                    <>
                      <li>
                        Short Deck (Or 6+ Hold'em) Is Played Identically To Texas Hold'em, But With
                        A <strong>36-Card Deck</strong>. All 2S, 3S, 4S, And 5S Are Removed.
                      </li>
                      <li>
                        Because Of The Altered Deck, The Math Of Drawing Hands Changes, Which Alters
                        The Standard Hand Rankings: <strong>A Flush Beats A Full House</strong>.
                      </li>
                      <li>
                        Aces Can Still Be Used As The Low Card For A Straight. The Lowest Possible
                        Straight Is <strong>A-6-7-8-9</strong>.
                      </li>
                      <li>
                        Each Player Receives Two Hole Cards, And Shares Five Community Cards To Make
                        The Best Five-Card Hand.
                      </li>
                    </>
                  ) : (
                    <>
                      <li>
                        Texas Hold'em Poker Hands Are Formed Of Five Cards. Players Use Any
                        Combination Of Their Hole Cards And The Community Cards To Form Their Best
                        Five-Card Hand.
                      </li>
                      <li>
                        Each Player Receives <strong>Two Hole Cards</strong> Face Down Before Any
                        Betting Begins.
                      </li>
                      <li>
                        There Follow Up To Four <strong>Betting Rounds</strong> During Which Players
                        Act In Turn To Check, Bet, Call, Or Fold.{' '}
                        <strong>Five Community Cards</strong> Are Dealt - A "Flop" Of Three, "Turn"
                        Of One, And "River" Of One.
                      </li>
                      <li>At Showdown, The Best 5-Card Poker Hand Wins The Pot.</li>
                    </>
                  )}
                  {isHiLo && (
                    <>
                      <li>
                        Each Pot Splits Between The Best High Hand And A Qualifying Low Hand. A Low
                        Requires Five Different Ranks, All Eight Or Lower, With Aces Low. Straights
                        And Flushes Do Not Count Against A Low. With No Qualifying Low, The High
                        Hand Wins The Whole Pot.
                      </li>
                      <li>
                        High And Low Each Use Exactly Two Hole Cards And Three Board Cards, And May
                        Use Different Cards. An Indivisible Chip Goes To The High Half.
                      </li>
                    </>
                  )}
                </ul>
                {isCashTable && (
                  <div>
                    <h3 className="rules-modal__section-title">Cash Button And Blinds</h3>
                    <ul className="rules-modal__bullet-list">
                      <li>
                        With Three Or More Players, The Button Moves Clockwise Among Eligible
                        Players, Skipping Empty Seats. New Players Wait For The Big Blind Or Post A
                        Live Big Blind To Enter, And Cannot Enter On The Button Or Small Blind In An
                        Established Game. A Sole Eligible Player Keeps The Button Until Other
                        Players Have Been Dealt In. A New Table Assigns Its First Button; At A New
                        Heads-Up Table, The First Button Is Drawn At Random.
                      </li>
                      <li>
                        Heads-Up, The Button Posts The Small Blind, Acts First Before The Flop, And
                        Acts Last After The Flop. When Play Becomes Heads-Up, The Big Blind Advances
                        To The Next Remaining Player So The Previous Big Blind Does Not Pay It
                        Twice. A New Opponent Enters In The Big Blind.
                      </li>
                      <li>
                        A Returning Player Who Missed Blinds Owes A Dead Small Blind And A Live Big
                        Blind. Dead Blind Chips Do Not Count Toward The Current Call.
                      </li>
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* ────────────────────────────────────────────────────────────────────────
                TAB 3: BETTING LIMITS
                ──────────────────────────────────────────────────────────────────────── */}
            {activeTab === 'limits' && (
              <div className="rules-modal__content">
                {isFixedLimit ? (
                  <>
                    <p className="rules-modal__text">
                      In Fixed Limit Games, Bets And Raises Use The Small Bet Before The Flop And On
                      The Flop, And Twice That Amount On The Turn And River. The Small Bet Is The
                      Big Blind. Posted Stakes Show Small Bet / Big Bet.
                    </p>
                    <p className="rules-modal__text">
                      Each Street Allows One Bet And Three Raises, Including Heads-Up. A Short
                      All-In Below Half A Full Bet Can Be Completed To The Full Bet; At Half A Bet
                      Or More, The Next Raise Adds A Full Bet. Reaching Half A Full Bet Reopens
                      Betting For A Player Who Already Acted.
                    </p>
                    <p className="rules-modal__text">
                      A Player May Call All-In For Less. They Can Win Only The Pots Covered By Their
                      Contribution; Other Eligible Players Contest The Side Pots.
                    </p>
                    {killPotRules && (
                      <p className="rules-modal__text">
                        {killPotRules.mode === 'full'
                          ? 'This Table Plays Kill Pots. '
                          : 'This Table Plays Half Kill Pots. '}
                        When One Player Wins Every Pot Of A Hand Worth{' '}
                        {killPotRules.thresholdBb.toLocaleString()} Big Blinds Or More, The Next
                        Hand Is A Kill Hand: That Player Posts A Live Kill Blind And Every Bet Is{' '}
                        {killPotRules.mode === 'full' ? 'Doubled' : 'One And A Half Times'} The
                        Usual Size. The Small And Big Blinds Do Not Change.
                      </p>
                    )}
                  </>
                ) : isPotLimit ? (
                  <>
                    <p className="rules-modal__text">
                      In Pot Limit Games, The Minimum Bet Is The Size Of The Big Blind And The
                      Maximum Raise Is The "Pot" (Combined Chips Already In The Pot Plus The
                      Player's Call Amount).
                    </p>
                    <p className="rules-modal__text">
                      Before The Flop, Pot-Limit Sizing Counts The Normal Small And Big Blinds At
                      Their Full Posted Amounts Even When A Blind Is All-In For Less. After The
                      Flop, Only Chips Actually In The Pot Count.
                    </p>
                    <p className="rules-modal__text">
                      For Example, In A 1/2 Pot Limit Game, The Blinds Are 1/2 And The First Player
                      To Act After The Blinds Are Posted Has Three Options: Fold, Call, Or Raise, Up
                      To A Maximum Of The "Pot."
                    </p>
                    <div className="rules-modal__callout">
                      <p>
                        <strong>To Calculate The Pot:</strong> Small Blind (1) + Big Blind (2) + The
                        Call Amount (2) = 5. This Is Added To The Call Amount To Make The Total Bet
                        Size <strong>7</strong>.
                      </p>
                    </div>
                    <p className="rules-modal__text">
                      The Next Player To Act Has The Same Three Options: Fold, Call (7) Or Raise. If
                      They Wish To Raise The Maximum, The Pot Is Calculated: Small Blind (1) + Big
                      Blind (2) + First Player's Raise (7) + The Call Amount (7) = 17. This Is Added
                      To The Call Amount (7) To Make The Total Bet Size <strong>24</strong>.
                    </p>
                    <p className="rules-modal__text">
                      When Players Do Not Have Enough Chips To Match A Full Bet, They May Call For
                      The Amount They Have Left (Are All-In) And Any Amount Over That Is Put Into A
                      "Side Pot" That Is Played For Only By Players Who Can Match The Bet.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="rules-modal__text">
                      In No Limit Games, The Minimum Bet Is The Size Of The Big Blind. There Is{' '}
                      <strong>No Maximum Bet Limit</strong>; A Player May Bet Any Amount Of Their
                      Current Chip Stack At Any Time.
                    </p>
                    <p className="rules-modal__text">
                      If A Player Wishes To Raise, Their Raise Must Be At Least The Size Of The
                      Previous Bet Or Raise In The Same Round. For Example, If A Player Bets 10, The
                      Next Player Must Raise To At Least 20.
                    </p>
                    <p className="rules-modal__text">
                      When A Player Pushes All Of Their Chips Into The Pot, They Are "All-In." If A
                      Player Does Not Have Enough Chips To Match An Opponent's Bet, They Can Call
                      With Their Remaining Chips To Create A "Side Pot" For The Remaining Active
                      Players.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* ────────────────────────────────────────────────────────────────────────
              TAB 4: HAND RANKINGS
              ──────────────────────────────────────────────────────────────────────── */}
            {activeTab === 'rankings' && (
              <div className="rules-modal__content rules-modal__content--rankings">
                {isShortDeck && (
                  <div className="rules-modal__ranking-notice">
                    Short Deck Rule: <strong>Flush Beats Full House</strong>
                  </div>
                )}

                <div className="rules-modal__hand-list">
                  {(isShortDeck ? SHORT_DECK_HANDS : STANDARD_HANDS).map((hand, idx) => (
                    <div key={idx} className="rules-modal__hand-item">
                      <h4 className="rules-modal__hand-title">{hand.name}</h4>
                      <div className="rules-modal__hand-row">
                        <div className="rules-modal__hand-cards">
                          {hand.cards.map((c, i) => (
                            <div key={i} className="rules-modal__hand-card-wrap">
                              <CardImage card={c} size="md" />
                            </div>
                          ))}
                        </div>
                        <p className="rules-modal__hand-desc">{hand.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default GameRulesModal;
