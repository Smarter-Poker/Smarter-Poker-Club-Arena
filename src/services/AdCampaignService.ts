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
}

export interface SubmitCampaignInput {
  clubId: string;
  slot: AdSlot;
  headline: string;
  imageUrl: string;
  targetUrl: string;
  startsAt: Date;
  days: number;
  scope?: 'platform' | 'own_club';
}

export interface SponsorCampaignInput {
  advertiserName: string;
  headline: string;
  slot: AdSlot;
  imageUrl: string;
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
  };
}

export const AdCampaignService = {
  /** Every surface, open or not, with its price and required creative size. */
  async rateCard(): Promise<AdRateCard[]> {
    const { data, error } = await supabase
      .from('ad_rate_card')
      .select(
        'slot, diamonds_per_day, min_days, max_days, creative_width, creative_height, max_bytes, is_open, label, blurb'
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
    }));
  },

  /**
   * Upload a creative for a club. Refuses, BEFORE uploading, a file of the
   * wrong type, over the weight budget, or not the exact pixel size the
   * surface requires - a picture that is the wrong shape would be letterboxed
   * on every player's screen, and the buyer would never know why.
   * Returns the same-origin path to store on the campaign.
   */
  async uploadCreative(
    clubId: string,
    slot: AdSlot,
    file: File,
    rate: AdRateCard
  ): Promise<string> {
    if (!ALLOWED_TYPES.includes(file.type)) {
      throw new Error('Use A WebP, PNG Or JPEG Image');
    }
    if (file.size > rate.maxBytes) {
      throw new Error(
        `That File Is ${Math.round(file.size / 1024)} KB. The Limit Is ${Math.round(rate.maxBytes / 1024)} KB`
      );
    }
    const { width, height } = await readImageSize(file);
    if (width !== rate.creativeWidth || height !== rate.creativeHeight) {
      throw new Error(
        `That Image Is ${width} x ${height}. The ${rate.label} Needs Exactly ${rate.creativeWidth} x ${rate.creativeHeight}`
      );
    }
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'webp';
    const objectPath = `club/${clubId}/${slot}-${Date.now()}.${ext}`;
    const { data, error } = await supabase.storage.from('ad-creatives').upload(objectPath, file, {
      cacheControl: '31536000',
      upsert: false,
      contentType: file.type,
    });
    if (error || !data) {
      reportError(error, 'AdCampaignService.uploadCreative');
      throw new Error('The Upload Did Not Go Through. Try Again');
    }
    return `/ad-creatives/${data.path}`;
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
    });
    if (error) {
      reportError(error, 'AdCampaignService.createSponsor');
      return { ok: false, reason: 'rpc_failed', detail: error.message };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === true) return { ok: true, campaignId: String(r.campaign_id) };
    return { ok: false, reason: String(r.reason ?? 'unknown') };
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
