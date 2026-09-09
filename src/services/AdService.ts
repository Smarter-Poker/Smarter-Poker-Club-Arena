/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AD SERVICE — house ads, and the first impression tracking this app has had
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "SINCE WE HAVE ZERO PAID ADS WE SHOULD BE PROMOTING OUR OWN
 * FEATURES AND CONTENTS IN THE AD SPACE."
 *
 * ── WHY THE RESOLVER IS AN RPC AND NOT A QUERY HERE ────────────────────────
 * Targeting is an entitlement question: who is eligible to see what, and how
 * often. Every rule lives in `fn_resolve_ads` so the client cannot disagree
 * with the database about eligibility, and so a future paid advertiser cannot
 * be billed for impressions a browser decided to serve itself. The client's
 * whole job is to render what it is handed and report what happened.
 *
 * ── VIP MEMBERS SEE ADS ────────────────────────────────────────────────────
 * Dan, same day, explicitly: "even vips will see ads remove that for now."
 * There is therefore NO VIP suppression anywhere in this file or in the
 * resolver, and the "Ad-Free Experience" line has been removed from every VIP
 * surface it was still sold on (the Geeves knowledge base was the live one).
 * If that ever reverses it changes in `fn_resolve_ads`, not here.
 *
 * ── TRACKING IS THE POINT, NOT A NICETY ────────────────────────────────────
 * This product ships eleven promotional surfaces and, before today, not one
 * of them recorded an impression or a click. We have been advertising for
 * months with no idea whether anybody looked. Logging is therefore
 * best-effort but never silent: a failed write is reported, because a
 * tracking system that quietly stops is worse than none — it produces
 * confident zeroes.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** The surfaces an ad can occupy. Mirrors the CHECK on `ad_placement.slot`. */
export type AdSlot =
  'lobby_strip' | 'session_summary' | 'empty_state' | 'hub_promotions' | 'table_between_hands';

export interface HouseAd {
  adId: string;
  adKey: string;
  category: string;
  headline: string;
  body: string | null;
  glyph: string | null;
  targetUrl: string | null;
  ctaLabel: string | null;
  /** Same-origin path or null. See isSafeAdImage for why it is checked twice. */
  imageUrl: string | null;
  /** The placement that won this surface: its creative, its cap, its override. */
  placementId: string | null;
  /**
   * Who is speaking. 'house' is smarter.poker promoting itself; 'club' is a
   * club owner who paid diamonds for the space; 'sponsor' is an outside
   * advertiser. Anything that is not the house gets labelled on render - the
   * FTC's native-advertising rule, and plain honesty with the player.
   */
  advertiserKind: 'house' | 'club' | 'sponsor';
  advertiserName: string | null;
}

/** Only these labels exist; an unknown kind from the wire is treated as a sponsor, never as the house. */
export function readAdvertiserKind(v: unknown): HouseAd['advertiserKind'] {
  return v === 'house' || v === 'club' ? v : 'sponsor';
}

/**
 * AN AD IMAGE IS A URL EVERY VIEWER'S BROWSER FETCHES WITHOUT BEING ASKED.
 *
 * A destination is checked before a browser is sent to it; an image is the same
 * question one step earlier and with less consent, because the fetch happens on
 * render. An external host would hand every player's IP and user agent to a
 * third party chosen by whoever typed the URL into the admin panel.
 *
 * The database has a CHECK and the API refuses one too. This is the third lock,
 * at the point of rendering, because that is the one that actually protects the
 * player if the other two are ever loosened.
 */
export function isSafeAdImage(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

/**
 * The DESTINATION half of the check the docstring above already promised.
 *
 * Dan 2026-08-28 round 2: that comment says "a destination is checked before a
 * browser is sent to it" — and it was not. `target_url` came off the row as
 * unvalidated text (`String(r.target_url)`), was typed `string | null`, was
 * entered through a bare text input on the admin page with no allowlist, and
 * was handed straight to `navigate(path)`. A database row therefore decided
 * where a seated player's router went. Two consequences, in order of severity:
 *
 *  1. `https://…` or `//evil.example` in that column sends players off-site,
 *     from a control they trust because it sits inside the club lobby. The
 *     lobby strip also rotates every seven seconds, so the destination under
 *     a player's thumb changes while they are reading it.
 *  2. Any in-app path that is not a tournament leaves /table/*, which
 *     collapses MultiTablePage and takes the action bar with it mid-hand.
 *
 * Same rule as the image, for the same reason: a rooted, same-origin path.
 * `//host` is rejected explicitly — it starts with `/` but is protocol-
 * relative, i.e. a different site. A backslash is rejected because browsers
 * normalise `/\evil.example` toward `//evil.example`.
 */
export function isSafeAdTarget(url: string | null | undefined): url is string {
  return (
    typeof url === 'string' &&
    url.startsWith('/') &&
    !url.startsWith('//') &&
    !url.startsWith('/\\') &&
    !url.includes('\\')
  );
}

/**
 * `impression` = rendered (the resolver answered and the creative was put in
 * the DOM). `viewable` = SEEN: at least half of the creative inside the
 * viewport for one continuous second, the MRC/IAB definition. Both are kept
 * because they answer different questions - "did we serve it" and "did anyone
 * look" - and only the second is worth money to an advertiser.
 */
type AdEventType = 'impression' | 'viewable' | 'click' | 'dismiss';

/**
 * Impressions already logged this page-load, keyed `adId:slot`.
 *
 * The lobby strip rotates every seven seconds and React re-renders for
 * unrelated reasons constantly; without this, one player idling in the lobby
 * would log an "impression" every few seconds and the click-through rate of
 * every campaign would be divided by a number that means nothing. One view
 * per ad per slot per page-load is the honest unit.
 */
const seenThisLoad = new Set<string>();

export const AdService = {
  /**
   * What should this player see in this slot right now?
   *
   * Returns [] on any failure. An advert is the one thing that must never
   * break a page or render an error in its place — but the failure is
   * reported, so an ad system that has quietly stopped serving is visible to
   * us rather than looking like "no campaigns are running".
   */
  async resolve(slot: AdSlot, clubId?: string | null, limit = 3): Promise<HouseAd[]> {
    try {
      const { data, error } = await supabase.rpc('fn_resolve_ads', {
        p_slot: slot,
        p_club_id: clubId ?? null,
        p_limit: limit,
      });
      if (error) {
        reportError(error, 'AdService.resolve', { slot });
        return [];
      }
      return (data || []).map((r: Record<string, unknown>) => ({
        adId: String(r.ad_id),
        adKey: String(r.ad_key),
        category: String(r.category),
        headline: String(r.headline ?? ''),
        body: r.body == null ? null : String(r.body),
        glyph: r.glyph == null ? null : String(r.glyph),
        targetUrl: r.target_url == null ? null : String(r.target_url),
        ctaLabel: r.cta_label == null ? null : String(r.cta_label),
        imageUrl: r.image_url == null ? null : String(r.image_url),
        placementId: r.placement_id == null ? null : String(r.placement_id),
        advertiserKind: readAdvertiserKind(r.advertiser_kind),
        advertiserName: r.advertiser_name == null ? null : String(r.advertiser_name),
      }));
    } catch (e) {
      reportError(e, 'AdService.resolve', { slot });
      return [];
    }
  },

  /**
   * Record that an ad was actually shown. De-duplicated per page-load.
   *
   * Fire-and-forget by design: nothing in the render path waits on this, and
   * a tracking failure must never delay or block the thing being tracked.
   */
  logImpression(ad: Pick<HouseAd, 'adId'>, slot: AdSlot, clubId?: string | null): void {
    const key = `${ad.adId}:${slot}`;
    if (seenThisLoad.has(key)) return;
    seenThisLoad.add(key);
    void AdService.logEvent(ad.adId, slot, 'impression', clubId);
  },

  /**
   * The creative was actually SEEN (50% in view for 1s). De-duplicated per
   * page-load exactly like the impression, under its own key, so one viewer
   * idling on a rotating strip counts once per creative, not once per lap.
   */
  logViewable(ad: Pick<HouseAd, 'adId'>, slot: AdSlot, clubId?: string | null): void {
    const key = `${ad.adId}:${slot}:viewable`;
    if (seenThisLoad.has(key)) return;
    seenThisLoad.add(key);
    void AdService.logEvent(ad.adId, slot, 'viewable', clubId);
  },

  /** A tap. Not de-duplicated — a player clicking twice really did click twice. */
  logClick(ad: Pick<HouseAd, 'adId'>, slot: AdSlot, clubId?: string | null): void {
    void AdService.logEvent(ad.adId, slot, 'click', clubId);
  },

  logDismiss(ad: Pick<HouseAd, 'adId'>, slot: AdSlot, clubId?: string | null): void {
    void AdService.logEvent(ad.adId, slot, 'dismiss', clubId);
  },

  /**
   * The write. `user_id` comes from the session because RLS demands it match
   * `auth.uid()` — a signed-out viewer simply does not log, which is correct:
   * we cannot frequency-cap somebody we cannot identify, and an anonymous
   * impression row would only inflate the denominator.
   */
  async logEvent(
    adId: string,
    slot: AdSlot,
    eventType: AdEventType,
    clubId?: string | null
  ): Promise<void> {
    try {
      const { data: auth } = await supabase.auth.getSession();
      const userId = auth?.session?.user?.id;
      if (!userId) return;
      const { error } = await supabase.from('ad_event').insert({
        ad_id: adId,
        user_id: userId,
        slot,
        event_type: eventType,
        club_id: clubId ?? null,
      });
      if (error) reportError(error, 'AdService.logEvent', { slot, eventType });
    } catch (e) {
      reportError(e, 'AdService.logEvent', { slot, eventType });
    }
  },
};

export default AdService;
