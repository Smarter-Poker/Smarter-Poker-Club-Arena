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
  const netClass = net === null ? '' : net > 0 ? 'cpm-up' : net < 0 ? 'cpm-down' : '';
  const netPrefix = net === null ? '' : net > 0 ? '+' : '';
  const initial = (username || '?').charAt(0).toUpperCase();

  return (
    <div className="cpm-overlay" onClick={onClose}>
      <div
        className="cpm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cpm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cpm-header">
          <h2 className="cpm-title" id="cpm-title">
            Profile
          </h2>
          <button className="cpm-close" onClick={onClose} aria-label="Close Profile">
            &#10005;
          </button>
        </div>

        <div className="cpm-body">
          <div className="cpm-user-section">
            <div className="cpm-avatar-container">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="cpm-avatar" />
              ) : (
                <span className="cpm-avatar-placeholder">{initial}</span>
              )}
            </div>
            <div className="cpm-user-info">
              <span className="cpm-username">{username}</span>
              <span className="cpm-user-id">ID: {playerNumber ?? '--'}</span>
              <span className="cpm-user-club">{clubName}</span>
            </div>
          </div>

          {/* `currentStack` is what the session service has watched arrive and
              leave, so it agrees with the Session Stats panel by construction
              rather than by a second, hand-rolled sum. */}
          <div className="cpm-section">
            <div className="cpm-section-title">At This Table</div>
            <div className="cpm-stat-grid">
              <div className="cpm-stat">
                <span className="cpm-stat-label">Stack</span>
                <span className="cpm-stat-value">
                  {stats ? fmtChips(stats.currentStack) : '--'}
                </span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Net</span>
                <span className={`cpm-stat-value ${netClass}`}>
                  {net === null ? '--' : `${netPrefix}${fmtChips(net)}`}
                </span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Big Blinds</span>
                <span className={`cpm-stat-value ${netClass}`}>
                  {stats ? `${netPrefix}${fmtWhole(stats.bigBlindsWon)}` : '--'}
                </span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Bought In</span>
                <span className="cpm-stat-value">{stats ? fmtChips(stats.buyInTotal) : '--'}</span>
              </div>
            </div>
          </div>

          <div className="cpm-section">
            <div className="cpm-section-title">This Session</div>
            <div className="cpm-stat-grid">
              <div className="cpm-stat">
                <span className="cpm-stat-label">Hands</span>
                <span className="cpm-stat-value">{stats ? fmtWhole(stats.handsPlayed) : '--'}</span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Won</span>
                <span className="cpm-stat-value">{stats ? fmtWhole(stats.handsWon) : '--'}</span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">VPIP</span>
                <span className="cpm-stat-value">
                  {stats ? fmtPercent(stats.vpipPercent) : '--'}
                </span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">PFR</span>
                <span className="cpm-stat-value">
                  {stats ? fmtPercent(stats.pfrPercent) : '--'}
                </span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Time</span>
                <span className="cpm-stat-value">{tableId ? duration : '--'}</span>
              </div>
              <div className="cpm-stat">
                <span className="cpm-stat-label">Per Hour</span>
                <span className="cpm-stat-value">
                  {stats ? fmtWhole(stats.handsPerHour) : '--'}
                </span>
              </div>
            </div>
          </div>

          {/* An observer, or anyone whose session has not started, gets a
              sentence instead of a grid of confident zeros. */}
          {!tableId && <div className="cpm-note">Session Figures Appear Once You Are Seated.</div>}
        </div>

        <div className="cpm-footer">
          <button className="cpm-confirm-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default ClubProfileModal;
