/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TABLE PROFILE — the hero's own card, in the Club Arena's clothes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Opens when the hero taps their OWN avatar at the table. TablePage:
 *
 *     onAvatarClick={() => { if (player?.isHero) setShowProfileModal(true); ... }}
 *
 * So this is a SELF profile. Tapping somebody else's avatar opens the
 * throwable selector and the notes target instead, and always did.
 *
 * ── WHAT THIS REPLACED (audit 2026-08-27, Dan: "gameplay must look like the
 *    Club Arena") ────────────────────────────────────────────────────────────
 *
 * A traced screenshot of a competitor's profile sheet, with a comment in it
 * that said so ("Mock emojis as per image"). Every part of it was scenery:
 *
 *   - four tab buttons (clock, snowflake, V, smiley) whose `activeTab` state
 *     was read ONLY to colour the tab you had just pressed. No tab showed
 *     different content, because there was no content;
 *   - a "Tag" text input whose value went into `useState` and was never read
 *     again, so anything the player typed was silently discarded on close;
 *   - two badges hard-coded to "Newbie" and "Normal" with a "?" beside them;
 *   - "Recently Used", followed by an empty div;
 *   - "Character Emojis": ten `[...Array(10)]` placeholder squares each
 *     priced at a diamond emoji and the number 2, buying nothing;
 *   - "Free Emojis Left: 0", from a prop no caller passes.
 *
 * It also broke the house style it was surrounded by: emoji as UI (forbidden
 * outright by .agent/workflows/design-guidelines.md), a hard-coded orange
 * close button, `font-family: sans-serif`, and a `z-index: 10000` that jumped
 * over the whole `--z-*` scale in design-tokens.css.
 *
 * ── WHAT IT IS NOW ─────────────────────────────────────────────────────────
 *
 * The same tap, answered honestly: who you are in this club, and how your
 * session at THIS table is actually going. Every figure on it is real and
 * comes from something that already exists:
 *
 *   identity   profiles.player_number (the "ID:" the rest of the app shows),
 *              plus the username, avatar and club name the caller already has
 *   session    sessionStatsService.getStats(tableId) - the same source the
 *              Session Stats panel reads, kept live by the same two bus
 *              events, so the two surfaces cannot disagree
 *
 * Nothing here invents a number, and nothing here is a placeholder. If a
 * figure cannot be read it renders as "--" rather than as a confident zero: a
 * stat that is quietly wrong is worse than one that admits it is unknown.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { sessionStatsService, type SessionStats } from '../../services/SessionStatsService';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import './ClubProfileModal.css';

export interface ClubProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  username: string;
  avatarUrl: string;
  clubName?: string;
  /** The table whose session is summarised. Absent for an unseated observer. */
  tableId?: string;
}

/** Chips, to the two decimal places every other cashier surface uses. */
const fmtChips = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Whole counts (hands, big blinds) never carry decimals. */
const fmtWhole = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');

const fmtPercent = (n: number) => `${Number.isFinite(n) ? Math.round(n) : 0}%`;

/** "1h 20m" / "45m". Mirrors the Session Stats panel's own formatter. */
function formatDuration(startedAt: number): string {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function ClubProfileModal({
  isOpen,
  onClose,
  userId,
  username,
  avatarUrl,
  clubName = 'Unknown',
  tableId,
}: ClubProfileModalProps) {
  /**
   * The player number the rest of the app calls "ID". Null while unread, and
   * it STAYS null on a failed read - the row below prints "--" rather than
   * inventing an id, which is the one thing a player might read out to support.
   */
  const [playerNumber, setPlayerNumber] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [duration, setDuration] = useState('0m');

  // ── Identity ──────────────────────────────────────────────────────────────
  // Fetched when the sheet OPENS rather than on mount: this modal spends most
  // of its life closed behind a tap most players never make, and a query fired
  // on every table render would be paid for by everyone.
  useEffect(() => {
    if (!isOpen || !userId) return;
    let live = true;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('player_number')
        .eq('id', userId)
        .maybeSingle();
      if (!live) return;
      if (error) {
        reportError(error, 'ClubProfileModal.playerNumber');
        return;
      }
      const raw = (data?.player_number as string | null) || null;
      setPlayerNumber(raw && String(raw).trim() ? String(raw).trim() : null);
    })();
    return () => {
      live = false;
    };
  }, [isOpen, userId]);

  // ── Session ───────────────────────────────────────────────────────────────
  const readStats = useCallback(() => {
    if (!tableId) return;
    setStats(sessionStatsService.getStats(tableId));
  }, [tableId]);

  useEffect(() => {
    if (!isOpen) return;
    readStats();
  }, [isOpen, readStats]);

  /**
   * The same two events the Session Stats panel listens to. Both are
   * subscribed unconditionally - a hook cannot be called behind an `if` - and
   * the guard inside each is what makes them free while the sheet is shut.
   */
  useMasterBusSubscription('SESSION_STATS_UPDATE', (payload: unknown) => {
    const p = payload as { tableId?: string; stats?: SessionStats } | null;
    if (!isOpen || !tableId || p?.tableId !== tableId) return;
    if (p?.stats) setStats(p.stats);
  });
  useMasterBusSubscription('HAND_COMPLETED', (payload: unknown) => {
    const p = payload as { tableId?: string } | null;
    if (!isOpen || !tableId || p?.tableId !== tableId) return;
    readStats();
  });

  // The clock ticks only while the sheet is open.
  useEffect(() => {
    if (!isOpen || !tableId) return;
    const startedAt = () => sessionStatsService.getStats(tableId)?.sessionStartTime ?? Date.now();
    setDuration(formatDuration(startedAt()));
    const t = setInterval(() => setDuration(formatDuration(startedAt())), 1000);
    return () => clearInterval(t);
  }, [isOpen, tableId]);

  // Escape closes, and the table behind stops scrolling. Both are what a
  // person expects of a sheet, and neither was here.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const net = stats ? stats.profitLoss : null;
  const netInk =
    net === null
      ? 'sc-ink--silver'
      : net > 0
        ? 'sc-ink--green'
        : net < 0
          ? 'sc-ink--red'
          : 'sc-ink--silver';
  const netPrefix = net === null ? '' : net > 0 ? '+' : '';
  const initial = (username || '?').charAt(0).toUpperCase();

  /* Every figure is a row on the glass: label in lit blue on the left, the
     value in silver on the right, an engraved rule between rows. */
  const tableRows: Array<[string, string, string]> = [
    ['Stack', stats ? fmtChips(stats.currentStack) : '--', 'sc-ink--silver'],
    ['Net', net === null ? '--' : `${netPrefix}${fmtChips(net)}`, netInk],
    ['Big Blinds', stats ? `${netPrefix}${fmtWhole(stats.bigBlindsWon)}` : '--', netInk],
    ['Bought In', stats ? fmtChips(stats.buyInTotal) : '--', 'sc-ink--silver'],
  ];
  const sessionRows: Array<[string, string]> = [
    ['Hands', stats ? fmtWhole(stats.handsPlayed) : '--'],
    ['Won', stats ? fmtWhole(stats.handsWon) : '--'],
    ['VPIP', stats ? fmtPercent(stats.vpipPercent) : '--'],
    ['PFR', stats ? fmtPercent(stats.pfrPercent) : '--'],
    ['Time', tableId ? duration : '--'],
    ['Per Hour', stats ? fmtWhole(stats.handsPerHour) : '--'],
  ];

  /* ONE CONSOLE (#ClubArenaConsole): the spade master. Who you are is the
     first row; the two sections print under their lit-blue labels; a page of
     content with one way out, so the foot is the flat cap and CLOSE is a lit
     word on the glass. Nothing is drawn. */
  return (
    <div className="cpm-overlay" onClick={onClose} role="presentation">
      <div
        className="cpc"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cpm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow={clubName}
          title="Profile"
          titleId="cpm-title"
          pill={tableId ? 'Seated' : 'Watching'}
          pillInk={tableId ? 'green' : 'muted'}
          foot="foot"
          className="cpc__console"
        >
          <div className="cpc__who">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="cpc__avatar" />
            ) : (
              <span className="cpc__avatar cpc__avatar--initial sc-ink--silver" aria-hidden="true">
                {initial}
              </span>
            )}
            <div className="cpc__who-lines">
              <span className="cpc__name sc-ink--silver">{username}</span>
              <span className="cpc__id sc-ink--muted">ID: {playerNumber ?? '--'}</span>
            </div>
          </div>

          {/* `currentStack` is what the session service has watched arrive and
              leave, so it agrees with the Session Stats panel by construction
              rather than by a second, hand-rolled sum. */}
          <section className="cpc__section" aria-label="At This Table">
            <h3 className="cpc__section-title sc-label sc-ink--blue">At This Table</h3>
            {tableRows.map(([label, value, ink]) => (
              <div key={label} className="cpc__row">
                <span className="cpc__row-label sc-ink--blue">{label}</span>
                <span className={`cpc__row-value ${ink}`}>{value}</span>
              </div>
            ))}
          </section>

          <section className="cpc__section" aria-label="This Session">
            <h3 className="cpc__section-title sc-label sc-ink--blue">This Session</h3>
            {sessionRows.map(([label, value]) => (
              <div key={label} className="cpc__row">
                <span className="cpc__row-label sc-ink--blue">{label}</span>
                <span className="cpc__row-value sc-ink--silver">{value}</span>
              </div>
            ))}
          </section>

          {/* An observer, or anyone whose session has not started, gets a
              sentence instead of a grid of confident zeros. */}
          {!tableId && (
            <p className="sc-copy sc-copy--center cpc__note">
              Session Figures Appear Once You Are Seated.
            </p>
          )}

          <div className="cpc__actions">
            <button
              type="button"
              className="cpc-word sc-ink--white"
              onClick={onClose}
              aria-label="Close Profile"
            >
              Close
            </button>
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default ClubProfileModal;
