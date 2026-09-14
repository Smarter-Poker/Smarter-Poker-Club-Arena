/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AD CAMPAIGN SERVICE - a club buys a flight, the house reviews it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03: "how we can implement club owners to start advertising
 * their club or events (using diamonds)."
 *
 * Every decision lives in Postgres (`fn_club_ad_submit`, `fn_club_ad_cancel`,
 * `fn_ad_campaign_review`, `fn_ad_campaign_list`): who may buy, what it
 * costs, whether the creative is in the club's own folder, whether the
 * destination is a same-origin path, and - inside the same transaction -
 * the diamond debit through the journal. This file uploads the picture,
 * calls the function, and repeats the answer. It never computes a price
 * the database has not confirmed.
 *
 * ── THE CREATIVE PATH IS THE SAME-ORIGIN LOCK ───────────────────────────────
 * The bucket is `ad-creatives`, the object is `club/<club id>/<file>`, and
 * the stored URL is `/ad-creatives/club/<club id>/<file>`: a rooted path on
 * smarter.poker (the World Hub rewrites `/ad-creatives/*` to the bucket).
 * That is what lets the catalog CHECK, the API and the render keep refusing
 * anything that is not on this site.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import type { AdSlot } from './AdService';

export interface AdRateCard {
  slot: AdSlot;
  diamondsPerDay: number;
  minDays: number;
  maxDays: number;
  creativeWidth: number;
  creativeHeight: number;
  maxBytes: number;
  isOpen: boolean;
  label: string;
  blurb: string;
  /** What an outside sponsor is invoiced per day, US cents. 0 = not for sale to a sponsor. */
  sponsorCentsPerDay: number;
}

export type CampaignStatus = 'submitted' | 'approved' | 'rejected' | 'cancelled';
export type CampaignDisplayStatus = CampaignStatus | 'scheduled' | 'live' | 'finished';

export interface AdCampaign {
  id: string;
  clubId: string | null;
  clubName: string;
  name: string;
  slot: AdSlot;
  status: CampaignStatus;
  displayStatus: CampaignDisplayStatus;
  scope: 'platform' | 'own_club';
  startsAt: string;
  endsAt: string;
  days: number;
  imageUrl: string;
  targetUrl: string;
  headline: string;
  diamondsCharged: number;
  diamondsRefunded: number;
  submittedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  impressions: number;
  viewable: number;
  clicks: number;
  viewers: number;
  /** The price a sponsor was shown when they booked, US cents. Null on a club flight. */
  quotedCents: number | null;
}

export interface SubmitCampaignInput {
  clubId: string;
  slot: AdSlot;
  headline: string;
  imageUrl: string;
  /** The 3:4 picture the full-screen popup shows (Dan 2026-09-13). */
  posterUrl: string;
  targetUrl: string;
  startsAt: Date;
  days: number;
  scope?: 'platform' | 'own_club';
}

/** A signed-in sponsor's own flight. No diamonds: a sponsor is invoiced off platform. */
export interface SponsorSelfSubmitInput {
  slot: AdSlot;
  headline: string;
  imageUrl: string;
  posterUrl: string;
  externalUrl: string;
  startsAt: Date;
  days: number;
  goalImpressions?: number | null;
  pacing?: 'even' | 'asap';
}

export interface SponsorAdvertiser {
  advertiserId: string;
  name: string;
  contactEmail: string | null;
  status: 'active' | 'suspended';
}

/** A sponsor's flight as fn_sponsor_campaign_list hands it back: a campaign plus what only a sponsor has. */
export interface SponsorCampaign extends AdCampaign {
  posterUrl: string | null;
  externalUrl: string | null;
  pacing: 'even' | 'asap';
  goalImpressions: number | null;
}

/** The poster every flight carries for the full-screen popup: 3:4, delivered 1080 x 1440. */
export const POSTER_SHAPE = {
  width: 1080,
  height: 1440,
  label: 'Poster',
  maxBytes: 614400,
} as const;

export interface SponsorCampaignInput {
  advertiserName: string;
  headline: string;
  slot: AdSlot;
  imageUrl: string;
  posterUrl?: string | null;
  /** The sponsor's own https address. Stored on the campaign, never served to a browser. */
  externalUrl: string;
  startsAt: Date;
  days: number;
  contactEmail?: string | null;
  goalImpressions?: number | null;
  pacing?: 'even' | 'asap';
}

export type SponsorCreateResult =
  | { ok: true; campaignId: string }
  | { ok: false; reason: string; detail?: string };

export interface AdCampaignDay {
  day: string;
  impressions: number;
  viewable: number;
  clicks: number;
  viewers: number;
}

export type SubmitResult =
  | { ok: true; campaignId: string; diamondsCharged: number; balance: number | null }
  | { ok: false; reason: string; detail?: string; minDays?: number; maxDays?: number };

const ALLOWED_TYPES = ['image/webp', 'image/png', 'image/jpeg'];

/** Reads a File's pixel size without uploading it. */
function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That File Is Not An Image This Browser Can Read'));
    };
    img.src = url;
  });
}

function mapCampaign(r: Record<string, unknown>): AdCampaign {
  return {
    id: String(r.id),
    clubId: r.club_id == null ? null : String(r.club_id),
    clubName: String(r.club_name ?? ''),
    name: String(r.name ?? ''),
    slot: String(r.slot) as AdSlot,
    status: String(r.status) as CampaignStatus,
    displayStatus: String(r.display_status) as CampaignDisplayStatus,
    scope: r.scope === 'own_club' ? 'own_club' : 'platform',
    startsAt: String(r.starts_at),
    endsAt: String(r.ends_at),
    days: Number(r.days ?? 0),
    imageUrl: String(r.image_url ?? ''),
    targetUrl: String(r.target_url ?? ''),
    headline: String(r.headline ?? ''),
    diamondsCharged: Number(r.diamonds_charged ?? 0),
    diamondsRefunded: Number(r.diamonds_refunded ?? 0),
    submittedBy: r.submitted_by == null ? null : String(r.submitted_by),
    reviewedAt: r.reviewed_at == null ? null : String(r.reviewed_at),
    reviewNote: r.review_note == null ? null : String(r.review_note),
    createdAt: String(r.created_at),
    impressions: Number(r.impressions ?? 0),
    viewable: Number(r.viewable ?? 0),
    clicks: Number(r.clicks ?? 0),
    viewers: Number(r.viewers ?? 0),
    quotedCents: r.quoted_cents == null ? null : Number(r.quoted_cents),
  };
}

/** Whole dollars for a forward-facing page: $10, never $10.00. */
export function formatDollars(cents: number): string {
  return `$${Math.floor(cents / 100).toLocaleString()}`;
}

export const AdCampaignService = {
  /** Every surface, open or not, with its price and required creative size. */
  async rateCard(): Promise<AdRateCard[]> {
    const { data, error } = await supabase
      .from('ad_rate_card')
      .select(
        'slot, diamonds_per_day, min_days, max_days, creative_width, creative_height, max_bytes, is_open, label, blurb, sponsor_cents_per_day'
      )
      .order('is_open', { ascending: false })
      .order('diamonds_per_day', { ascending: false });
    if (error) {
      reportError(error, 'AdCampaignService.rateCard');
      throw error;
    }
    return (data || []).map((r) => ({
      slot: String(r.slot) as AdSlot,
      diamondsPerDay: Number(r.diamonds_per_day),
      minDays: Number(r.min_days),
      maxDays: Number(r.max_days),
      creativeWidth: Number(r.creative_width),
      creativeHeight: Number(r.creative_height),
      maxBytes: Number(r.max_bytes),
      isOpen: Boolean(r.is_open),
      label: String(r.label),
      blurb: String(r.blurb ?? ''),
      sponsorCentsPerDay: Number(r.sponsor_cents_per_day ?? 0),
    }));
  },

  /**
   * Upload a creative into an advertiser's own folder. Refuses, BEFORE
   * uploading, a file of the wrong type, over the weight budget, or not the
   * exact pixel size the shape requires - a picture that is the wrong shape
   * would be letterboxed on every player's screen, and the buyer would never
   * know why. The folder is `club/<club id>` for a club and
   * `sponsor/<advertiser id>` for a sponsor; the storage policy admits only
   * the owner of that folder, and the submit RPC refuses a path outside it.
   * Returns the same-origin path to store on the campaign.
   */
  async uploadTo(
    folder: string,
    name: string,
    file: File,
    shape: { width: number; height: number; label: string; maxBytes: number }
  ): Promise<string> {
    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new Error('Use A WebP, PNG Or JPEG Image');
    }
    if (file.size > shape.maxBytes) {
      throw new Error(
        `That File Is ${Math.round(file.size / 1024)} KB. The Limit Is ${Math.round(shape.maxBytes / 1024)} KB`
      );
    }
    const { width, height } = await readImageSize(file);
    if (width !== shape.width || height !== shape.height) {
      throw new Error(
        `That Image Is ${width} x ${height}. The ${shape.label} Needs Exactly ${shape.width} x ${shape.height}`
      );
    }
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'webp';
    const objectPath = `${folder}/${name}-${Date.now()}.${ext}`;
    const { data, error } = await supabase.storage.from('ad-creatives').upload(objectPath, file, {
      cacheControl: '31536000',
      upsert: false,
      contentType: file.type,
    });
    if (error || !data) {
      reportError(error, 'AdCampaignService.uploadTo');
      throw new Error('The Upload Did Not Go Through. Try Again');
    }
    return `/ad-creatives/${data.path}`;
  },

  /** Upload a surface creative for a club, at the size its rate card row requires. */
  async uploadCreative(
    clubId: string,
    slot: AdSlot,
    file: File,
    rate: AdRateCard
  ): Promise<string> {
    return AdCampaignService.uploadTo(`club/${clubId}`, slot, file, {
      width: rate.creativeWidth,
      height: rate.creativeHeight,
      label: rate.label,
      maxBytes: rate.maxBytes,
    });
  },

  /** Upload the 3:4 poster for a club flight. */
  async uploadPoster(clubId: string, file: File): Promise<string> {
    return AdCampaignService.uploadTo(`club/${clubId}`, 'poster', file, POSTER_SHAPE);
  },

  /** Buy a flight. The diamonds leave in the same transaction the campaign is created in. */
  async submit(input: SubmitCampaignInput): Promise<SubmitResult> {
    const { data, error } = await supabase.rpc('fn_club_ad_submit', {
      p_club_id: input.clubId,
      p_slot: input.slot,
      p_headline: input.headline,
      p_image_url: input.imageUrl,
      p_target_url: input.targetUrl,
      p_starts_at: input.startsAt.toISOString(),
      p_days: input.days,
      p_scope: input.scope ?? 'platform',
      p_poster_url: input.posterUrl,
    });
    if (error) {
      reportError(error, 'AdCampaignService.submit');
      return { ok: false, reason: 'rpc_failed', detail: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === true) {
      return {
        ok: true,
        campaignId: String(r.campaign_id),
        diamondsCharged: Number(r.diamonds_charged ?? 0),
        balance: r.balance == null ? null : Number(r.balance),
      };
    }
    return {
      ok: false,
      reason: String(r.reason ?? 'unknown'),
      detail: r.detail == null ? undefined : String(r.detail),
      minDays: r.min_days == null ? undefined : Number(r.min_days),
      maxDays: r.max_days == null ? undefined : Number(r.max_days),
    };
  },

  /** Withdraw a flight that has not been reviewed yet; the diamonds come back. */
  async cancel(
    campaignId: string
  ): Promise<{ ok: boolean; reason?: string; diamondsRefunded?: number }> {
    const { data, error } = await supabase.rpc('fn_club_ad_cancel', { p_campaign_id: campaignId });
    if (error) {
      reportError(error, 'AdCampaignService.cancel');
      return { ok: false, reason: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    return {
      ok: r.ok === true,
      reason: r.reason == null ? undefined : String(r.reason),
      diamondsRefunded: r.diamonds_refunded == null ? undefined : Number(r.diamonds_refunded),
    };
  },

  /** Platform staff: approve (it becomes inventory) or reject (it is refunded). */
  async review(
    campaignId: string,
    decision: 'approve' | 'reject',
    note?: string
  ): Promise<{ ok: boolean; reason?: string; status?: string }> {
    const { data, error } = await supabase.rpc('fn_ad_campaign_review', {
      p_campaign_id: campaignId,
      p_decision: decision,
      p_note: note ?? null,
    });
    if (error) {
      reportError(error, 'AdCampaignService.review');
      return { ok: false, reason: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    return {
      ok: r.ok === true,
      reason: r.reason == null ? undefined : String(r.reason),
      status: r.status == null ? undefined : String(r.status),
    };
  },

  /**
   * A club's own campaigns (pass its id) or, for platform staff, everyone's
   * (pass null). Authorisation is inside the function; an unauthorised caller
   * gets an empty list, not somebody else's campaigns.
   */
  async list(clubId: string | null): Promise<AdCampaign[]> {
    const { data, error } = await supabase.rpc('fn_ad_campaign_list', { p_club_id: clubId });
    if (error) {
      reportError(error, 'AdCampaignService.list');
      throw error;
    }
    return ((data || []) as Record<string, unknown>[]).map(mapCampaign);
  },

  /**
   * Platform staff open a flight for an outside advertiser. No diamonds change
   * hands: a sponsor is invoiced off-platform by a person, so the money is not
   * this system's business. It lands in the SAME review queue a club's flight
   * does, because one approval path is easier to trust than two.
   */
  async createSponsor(input: SponsorCampaignInput): Promise<SponsorCreateResult> {
    const { data, error } = await supabase.rpc('fn_sponsor_campaign_create', {
      p_advertiser_name: input.advertiserName,
      p_headline: input.headline,
      p_slot: input.slot,
      p_image_url: input.imageUrl,
      p_external_url: input.externalUrl,
      p_starts_at: input.startsAt.toISOString(),
      p_days: input.days,
      p_contact_email: input.contactEmail ?? null,
      p_goal_impressions: input.goalImpressions ?? null,
      p_pacing: input.pacing ?? 'even',
      p_poster_url: input.posterUrl ?? null,
    });
    if (error) {
      reportError(error, 'AdCampaignService.createSponsor');
      return { ok: false, reason: 'rpc_failed', detail: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === true) return { ok: true, campaignId: String(r.campaign_id) };
    return { ok: false, reason: String(r.reason ?? 'unknown') };
  },

  // ── A sponsor, signed in, owning their own flights (2026-09-13) ─────────────

  /** My sponsor advertiser, or null when this account has never opened one. */
  async sponsorMine(): Promise<SponsorAdvertiser | null> {
    const { data, error } = await supabase.rpc('fn_sponsor_advertiser_mine');
    if (error) {
      reportError(error, 'AdCampaignService.sponsorMine');
      throw error;
    }
    if (data == null) return null;
    const r = data as Record<string, unknown>;
    if (r.advertiser_id == null) return null;
    return {
      advertiserId: String(r.advertiser_id),
      name: String(r.name ?? ''),
      contactEmail: r.contact_email == null ? null : String(r.contact_email),
      status: r.status === 'suspended' ? 'suspended' : 'active',
    };
  },

  /** Open (or rename) my sponsor advertiser. One per account; the database holds the line. */
  async sponsorUpsert(
    name: string,
    contactEmail: string | null
  ): Promise<{ ok: true; advertiserId: string } | { ok: false; reason: string }> {
    const { data, error } = await supabase.rpc('fn_sponsor_advertiser_upsert', {
      p_name: name,
      p_contact_email: contactEmail,
    });
    if (error) {
      reportError(error, 'AdCampaignService.sponsorUpsert');
      return { ok: false, reason: 'rpc_failed' };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === true) return { ok: true, advertiserId: String(r.advertiser_id) };
    return { ok: false, reason: String(r.reason ?? 'unknown') };
  },

  /** Upload a surface creative into my sponsor folder. */
  async sponsorUploadCreative(
    advertiserId: string,
    slot: AdSlot,
    file: File,
    rate: AdRateCard
  ): Promise<string> {
    return AdCampaignService.uploadTo(`sponsor/${advertiserId}`, slot, file, {
      width: rate.creativeWidth,
      height: rate.creativeHeight,
      label: rate.label,
      maxBytes: rate.maxBytes,
    });
  },

  /** Upload the 3:4 poster into my sponsor folder. */
  async sponsorUploadPoster(advertiserId: string, file: File): Promise<string> {
    return AdCampaignService.uploadTo(`sponsor/${advertiserId}`, 'poster', file, POSTER_SHAPE);
  },

  /**
   * Submit my flight. It lands in the same review queue a club's does and
   * nothing serves until staff approve it. No diamonds move.
   */
  async sponsorSubmit(input: SponsorSelfSubmitInput): Promise<SponsorCreateResult> {
    const { data, error } = await supabase.rpc('fn_sponsor_ad_submit', {
      p_slot: input.slot,
      p_headline: input.headline,
      p_image_url: input.imageUrl,
      p_poster_url: input.posterUrl,
      p_external_url: input.externalUrl,
      p_starts_at: input.startsAt.toISOString(),
      p_days: input.days,
      p_goal_impressions: input.goalImpressions ?? null,
      p_pacing: input.pacing ?? 'even',
    });
    if (error) {
      reportError(error, 'AdCampaignService.sponsorSubmit');
      return { ok: false, reason: 'rpc_failed', detail: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === true) return { ok: true, campaignId: String(r.campaign_id) };
    return { ok: false, reason: String(r.reason ?? 'unknown') };
  },

  /** My flights and their numbers. */
  async sponsorList(): Promise<SponsorCampaign[]> {
    const { data, error } = await supabase.rpc('fn_sponsor_campaign_list');
    if (error) {
      reportError(error, 'AdCampaignService.sponsorList');
      throw error;
    }
    return ((data || []) as Record<string, unknown>[]).map((r) => ({
      ...mapCampaign(r),
      posterUrl: r.poster_url == null ? null : String(r.poster_url),
      externalUrl: r.external_url == null ? null : String(r.external_url),
      pacing: r.pacing === 'asap' ? 'asap' : 'even',
      goalImpressions: r.goal_impressions == null ? null : Number(r.goal_impressions),
    }));
  },

  /**
   * Day-by-day numbers for one campaign, computed at the moment they are asked
   * for. Deliberately not a rollup table and not a scheduled job: a number that
   * is recomputed on read cannot quietly go stale, and section 11 routes every
   * scheduled trigger through Open Claw anyway.
   */
  async report(campaignId: string): Promise<AdCampaignDay[]> {
    const { data, error } = await supabase.rpc('fn_ad_campaign_report', {
      p_campaign_id: campaignId,
    });
    if (error) {
      reportError(error, 'AdCampaignService.report');
      throw error;
    }
    return ((data || []) as Record<string, unknown>[]).map((r) => ({
      day: String(r.day),
      impressions: Number(r.impressions ?? 0),
      viewable: Number(r.viewable ?? 0),
      clicks: Number(r.clicks ?? 0),
      viewers: Number(r.viewers ?? 0),
    }));
  },
};

export default AdCampaignService;
