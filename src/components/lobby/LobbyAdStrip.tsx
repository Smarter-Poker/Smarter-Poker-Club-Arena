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
 * Three sources, always LABELLED, never merged into an anonymous feed:
 *   CLUB   — club_announcements for this club
 *   UNION  — union_announcements for the union this club belongs to
 *   HOUSE  — smarter.poker's own promotions, from the house-ad catalog
 *            (Dan 2026-08-27: with no paid advertisers, the ad space promotes
 *            our own features). House ads sort LAST: a club that wrote a
 *            notice to its own players outranks us advertising ourselves in
 *            their lobby, always.
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
import { AdService, isSafeAdTarget } from '../../services/AdService';
import './LobbyAdStrip.css';

export interface LobbyAd {
  id: string;
  source: 'CLUB' | 'UNION' | 'HOUSE';
  title: string | null;
  body: string;
  pinned: boolean;
  /** House ads only: catalog id for impression/click tracking. */
  adId?: string;
  /** House ads only: where a tap should go. */
  targetUrl?: string | null;
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
  /** Where a HOUSE ad's own target_url should take the player. Without it a
   *  house ad falls back to `onOpen`, so the strip never becomes a dead tap. */
  onNavigate?: (path: string) => void;
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
  onNavigate,
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

        const [clubRes, unionRes, houseAds] = await Promise.all([
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
          /* HOUSE ADS (2026-08-27). Resolved server-side: every targeting and
             frequency-cap rule lives in fn_resolve_ads so the client cannot
             disagree with the database about who was eligible. Returns [] on
             any failure, so the strip degrades to club + union notices rather
             than breaking. */
          AdService.resolve('lobby_strip', clubId, MAX_ADS),
        ]);

        if (cancelled) return;

        /* PostgREST resolves a query-level failure (RLS refusal, bad column, a
           malformed .or) as { data: null, error } rather than rejecting, so
           neither of these ever reached the catch below. The strip rendered
           empty, which is indistinguishable from "this club has no
           announcements" - the exact silence that catch exists to break. */
        if (clubRes.error) reportError(clubRes.error, 'LobbyAdStrip.loadClubAds');
        if (unionRes.error) reportError(unionRes.error, 'LobbyAdStrip.loadUnionAds');

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

        const houseLobbyAds: LobbyAd[] = (houseAds || []).map((h) => ({
          id: `house:${h.adId}`,
          source: 'HOUSE' as const,
          title: h.headline ? String(h.headline).trim() : null,
          body: firstLine(h.body),
          pinned: false,
          adId: h.adId,
          targetUrl: h.targetUrl,
        }));

        /* Pinned club notices lead — a club pins something because it wants it
           seen first — then union notices, then the rest of the club's, and
           HOUSE ads last. That order is deliberate and is the rule: a club
           that wrote a notice to its own players outranks smarter.poker
           advertising itself in that club's lobby. House ads fill the space
           that would otherwise be empty; they never displace a club's voice. */
        const merged = [
          ...clubAds.filter((a) => a.pinned),
          ...unionAds,
          ...clubAds.filter((a) => !a.pinned),
          ...houseLobbyAds,
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

  /* IMPRESSION LOGGING (2026-08-27). Fires for the ad currently on screen,
     de-duplicated per page-load inside AdService — this strip rotates every
     seven seconds and re-renders for unrelated reasons, so counting every
     render would divide every campaign's click-through rate by a number that
     means nothing. Only HOUSE ads are tracked: club and union notices are
     somebody else's message, not our inventory, and logging a club's
     announcement into our ad analytics would be measuring the wrong thing. */
  const visibleAd = ads.length > 0 ? ads[Math.min(index, ads.length - 1)] : null;
  const visibleHouseAdId = visibleAd?.source === 'HOUSE' ? visibleAd.adId : undefined;
  useEffect(() => {
    if (!visibleHouseAdId) return;
    AdService.logImpression({ adId: visibleHouseAdId }, 'lobby_strip', clubId);
  }, [visibleHouseAdId, clubId]);

  if (ads.length === 0) return null;

  const ad = ads[Math.min(index, ads.length - 1)];

  /* A house ad owns its own destination, so tapping it goes where the campaign
     points rather than to the club's announcements page. The click is recorded
     BEFORE navigating: the alternative is losing the event to the unmount. */
  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ad.source === 'HOUSE' && ad.adId) {
      AdService.logDismiss({ adId: ad.adId }, 'lobby_strip', clubId);
    }
    const nextAds = ads.filter((a) => a.id !== ad.id);
    setAds(nextAds);
    setIndex((prev) => Math.max(0, Math.min(prev, nextAds.length - 1)));
  };

  /* The destination this strip would actually route to, resolved and checked
     once, so that everything downstream agrees about it.

     Validated AFTER the {clubId} substitution, never before: the check has to
     see the string the router will actually receive, or a template could
     smuggle a destination past it. See isSafeAdTarget. */
  const houseTarget = (() => {
    if (ad.source !== 'HOUSE' || !ad.adId || !ad.targetUrl) return null;
    const url = clubId ? ad.targetUrl.replace(/{clubId}/g, clubId) : ad.targetUrl;
    return isSafeAdTarget(url) ? url : null;
  })();

  const handleActivate = () => {
    /* THE CLICK IS LOGGED ONLY WHERE ONE HAPPENED. It used to be logged the
       moment a house strip was activated, before the target had been checked,
       so an ad whose destination the client refuses recorded a click and then
       went nowhere. Those are the worst events we can hold: they are
       indistinguishable in the panel from a campaign that is working, and the
       click-through rate they inflate is the number an operator uses to decide
       what to run next. An unsafe target falls through to `onOpen` - a promo
       that opens the wrong thing is a bug; one that leaves the site is a
       different and worse problem. */
    if (houseTarget && ad.adId) {
      AdService.logClick({ adId: ad.adId }, 'lobby_strip', clubId);
      onNavigate?.(houseTarget);
      return;
    }
    onOpen?.();
  };
  const text = ad.title ? (ad.body ? `${ad.title} - ${ad.body}` : ad.title) : ad.body;

  /* A button only when there is something to open. `onOpen` is optional, and
     without it the strip was still focusable, still showed a pointer cursor
     and a focus ring, and did nothing when clicked. */
  const stripClass = `lobby-ads__strip lobby-ads__strip--${ad.source.toLowerCase()}`;
  /* houseTarget, not Boolean(ad.targetUrl): a house ad whose destination the
     client refuses has nowhere to go, and rendering it as a button offered a
     pointer cursor, a focus ring and a tap that did nothing. */
  const isActivatable = Boolean(onOpen) || Boolean(houseTarget);
  if (!isActivatable) {
    return (
      <div className="lobby-ads">
        <div className={`${stripClass} lobby-ads__strip--static`}>
          <span className="lobby-ads__icon" aria-hidden="true">
            <IconMegaphone />
          </span>
          <span className="lobby-ads__tag">{ad.source}</span>
          <span key={ad.id} className="lobby-ads__text">
            {text}
          </span>
        </div>
        <button
          type="button"
          className="lobby-ads__dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss Announcement"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="lobby-ads">
      <button
        type="button"
        className={stripClass}
        onClick={handleActivate}
        // Not aria-live: this rotates on a timer, and announcing every 7s
        // interrupts a screen-reader user mid-task. The strip is reachable and
        // readable on demand instead.
        aria-label={`${ad.source} Announcement: ${text}`}
      >
        <span className="lobby-ads__icon" aria-hidden="true">
          <IconMegaphone />
        </span>
        <span className="lobby-ads__tag">{ad.source}</span>
        <span key={ad.id} className="lobby-ads__text">
          {text}
        </span>
      </button>
      <button
        type="button"
        className="lobby-ads__dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss Announcement"
      >
        ✕
      </button>
    </div>
  );
}
