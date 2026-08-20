/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOBBY AD STRIP — club + union notices, one compact line under the game bar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20. Clubs and unions had nowhere to advertise inside the lobby:
 * announcements existed in the DB and on their own pages, which means they only
 * reached players who already went looking for them. A promotion nobody sees is
 * a promotion that does not run. This strip sits directly beneath the game
 * action bar — the last thing a player passes before choosing a table.
 *
 * Two sources, always LABELLED, never merged into an anonymous feed:
 *   CLUB   — club_announcements for this club
 *   UNION  — union_announcements for the union this club belongs to
 *
 * The label matters. Content from the two levels may be shown together, but a
 * player must always be able to tell who is speaking — the club they joined, or
 * the union above it. (Money is a different matter entirely and is never
 * combined; see the WALLET SEPARATION LAW in DynamicWallet.tsx.)
 *
 * Renders NOTHING when there is nothing to say. An empty promotional bar is
 * worse than no bar: it takes vertical space on a 375px screen and trains
 * players to ignore the region.
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { IconMegaphone } from '../icons/LobbyIcons';
import { reportError } from '../../utils/errorReporter';
import './LobbyAdStrip.css';

export interface LobbyAd {
  id: string;
  source: 'CLUB' | 'UNION';
  title: string | null;
  body: string;
  pinned: boolean;
}

interface LobbyAdStripProps {
  /** Resolved club UUID. */
  clubId: string | null;
  /** Union UUID when this club sits inside a union, else null. */
  unionId?: string | null;
  /** Rotation interval in ms. */
  intervalMs?: number;
  /** Tapping the strip — usually navigates to the announcements page. */
  onOpen?: () => void;
}

const MAX_ADS = 6;

function firstLine(s: string | null | undefined): string {
  if (!s) return '';
  // Announcements are free text and routinely contain hard newlines. This is a
  // ONE-LINE strip, so a multi-line body would either blow the row height out
  // or get clipped mid-sentence; take the first non-empty line and let CSS
  // ellipsis handle the rest.
  const line = String(s)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line || '';
}

export default function LobbyAdStrip({
  clubId,
  unionId = null,
  intervalMs = 7000,
  onOpen,
}: LobbyAdStripProps) {
  const [ads, setAds] = useState<LobbyAd[]>([]);
  const [index, setIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!clubId) {
      setAds([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const nowIso = new Date().toISOString();

        const [clubRes, unionRes] = await Promise.all([
          supabase
            .from('club_announcements')
            .select('id, title, message, content, is_pinned, is_active, expires_at, created_at')
            .eq('club_id', clubId)
            // is_active is nullable and older rows predate the column, so a
            // plain .eq('is_active', true) hid every historical announcement.
            .or('is_active.is.null,is_active.eq.true')
            .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
            .order('is_pinned', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(MAX_ADS),
          unionId
            ? supabase
                .from('union_announcements')
                .select('id, message, created_at')
                .eq('union_id', unionId)
                .order('created_at', { ascending: false })
                .limit(MAX_ADS)
            : Promise.resolve({ data: [], error: null } as { data: any[]; error: null }),
        ]);

        if (cancelled) return;

        const clubAds: LobbyAd[] = (clubRes.data || [])
          .map((r: any) => ({
            id: `club:${r.id}`,
            source: 'CLUB' as const,
            title: r.title ? String(r.title).trim() : null,
            body: firstLine(r.message ?? r.content),
            pinned: r.is_pinned === true,
          }))
          .filter((a: LobbyAd) => a.body.length > 0 || (a.title || '').length > 0);

        const unionAds: LobbyAd[] = (unionRes.data || [])
          .map((r: any) => ({
            id: `union:${r.id}`,
            source: 'UNION' as const,
            title: null,
            body: firstLine(r.message),
            pinned: false,
          }))
          .filter((a: LobbyAd) => a.body.length > 0);

        // Pinned club notices lead — a club pins something because it wants it
        // seen first — then union notices, then the rest of the club's.
        const merged = [
          ...clubAds.filter((a) => a.pinned),
          ...unionAds,
          ...clubAds.filter((a) => !a.pinned),
        ].slice(0, MAX_ADS);

        setAds(merged);
        setIndex(0);
      } catch (e) {
        // A failed notice fetch must never take the lobby down with it, and it
        // must never render an error where an advert goes. Report and stay silent.
        reportError(e, 'LobbyAdStrip.load');
        if (!cancelled) setAds([]);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [clubId, unionId]);

  // ── Rotate ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (ads.length < 2) return;

    // Respect reduced-motion: an auto-advancing strip is motion. Users who ask
    // for less of it get the first (highest-priority) notice, held still.
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    timerRef.current = setInterval(
      () => {
        setIndex((i) => (i + 1) % ads.length);
      },
      Math.max(3000, intervalMs)
    );

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [ads.length, intervalMs]);

  if (ads.length === 0) return null;

  const ad = ads[Math.min(index, ads.length - 1)];
  const text = ad.title ? (ad.body ? `${ad.title} — ${ad.body}` : ad.title) : ad.body;

  return (
    <div className="lobby-ads">
      <button
        type="button"
        className={`lobby-ads__strip lobby-ads__strip--${ad.source.toLowerCase()}`}
        onClick={onOpen}
        // Not aria-live: this rotates on a timer, and announcing every 7s
        // interrupts a screen-reader user mid-task. The strip is reachable and
        // readable on demand instead.
        aria-label={`${ad.source} announcement: ${text}`}
      >
        <span className="lobby-ads__icon" aria-hidden="true">
          <IconMegaphone />
        </span>
        <span className="lobby-ads__tag">{ad.source}</span>
        <span key={ad.id} className="lobby-ads__text">
          {text}
        </span>
      </button>

      {ads.length > 1 && (
        <div className="lobby-ads__dots" role="tablist" aria-label="Announcements">
          {ads.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Announcement ${i + 1} of ${ads.length}`}
              className={`lobby-ads__dot ${i === index ? 'is-active' : ''}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
