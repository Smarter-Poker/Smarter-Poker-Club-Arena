/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOUSE ADS — the smarter.poker promotion desk
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: build the ad architecture, fill the space with our own
 * features while there are no paid advertisers, and give it a UI panel for
 * smarter.poker inside the admin area.
 *
 * ── PLATFORM STAFF ONLY, AND THE PAGE SAYS SO ─────────────────────────────
 * A house ad runs in EVERY club's lobby. A club owner writes their own
 * announcements (Admin > Announce); nobody but smarter.poker staff puts a
 * message into somebody else's lobby. This page gates on
 * `profiles.role IN ('admin','super_admin')` and the API route behind it
 * checks the same thing again — the UI check is a courtesy so staff see a
 * clear refusal instead of a failed save, and the route is the actual lock.
 * `ad_catalog` additionally carries no write policy at all, so RLS refuses
 * every browser write regardless of both.
 *
 * ── WHAT THE NUMBERS MEAN, AND WHEN THEY ARE ABSENT ───────────────────────
 * This is the first surface in the product that can answer "did anyone look".
 * Eleven promotional surfaces shipped before this one and none of them ever
 * recorded an impression. So the stats column is the point of the page, and
 * `stats: null` from the API means COULD NOT COUNT and renders as a dash —
 * never as a zero. A confident zero reads as "this campaign failed" when the
 * truth is "we did not measure it", and that is exactly the class of lie this
 * codebase keeps having to dig out.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { confirmDialog } from '../../components/common/confirmDialog';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { reportError } from '../../utils/errorReporter';
import { useIsMounted } from '../../hooks/useIsMounted';
import '../AdminDashboardPage.css';

interface AdRow {
  id: string;
  ad_key: string;
  /* Same-origin paths only. An external image URL hands every viewer's IP and
     user agent to a third party chosen by whoever typed it in - the database
     carries the same CHECK, so this field cannot hold anything else. */
  image_url?: string | null;
  /* Two campaigns sharing a key are variants of one test. The weighted draw
     already splits traffic between them; this is what lets a report say so. */
  experiment_key?: string | null;
  category: string;
  headline: string;
  body: string | null;
  glyph: string | null;
  target_url: string | null;
  cta_label: string | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  weight: number;
  created_at: string;
}

interface PlacementRow {
  id: string;
  ad_id: string;
  slot: string;
  club_id: string | null;
  audience: string | null;
  daily_cap: number | null;
  /* The per-surface destination override. fn_resolve_ads serves
     COALESCE(pl.target_url, c.target_url), so when this is set it is what the
     player's browser is handed - and eight live placements set it. It was
     never read into this panel and never written from it, which made "Links
     To" on the campaign a control that answered "Saved." and changed nothing
     on the surface actually serving. */
  target_url: string | null;
  is_active: boolean;
}

type StatRow = { impressions: number; clicks: number; dismisses: number };

/* PER-SURFACE NUMBERS (2026-08-28). Until today this panel showed one blended
   total per campaign, which was right when one slot existed. `bbj_running` now
   runs on four surfaces, and a single number told an operator nothing about
   which of them is working - while the obvious action on a poor blended
   number, turning the campaign off, can be exactly the wrong one.

   Keyed adId -> slot -> counts. `null` still means COULD NOT COUNT and still
   renders as a dash, never as a zero. */
/* PEOPLE, NOT EVENTS. The lobby logs one impression per advert per page load,
   so a player who reloads thirty times is thirty impressions and one person.
   Production on the day this shipped: spins_jackpot had 65 impressions on
   lobby_strip and 5 viewers. Read as reach, 65 is a campaign doing well; 5 is
   the truth. Both are shown, because the ratio between them is frequency, and
   frequency is the difference between working and nagging. */
type SlotStatRow = StatRow & {
  viewers: number;
  clickers: number;
  lastEventAt: string | null;
};
type StatsBySlot = Record<string, Record<string, SlotStatRow>>;

/* WHY A SURFACE IS QUIET. Views and clicks say what happened; they cannot say
   what did not. A silent placement has three completely different causes - no
   placement at all, no audience match, or everybody already capped out for the
   day - and until this they looked identical from here.

   Counted in PEOPLE over the rolling 24h window, because the operator question
   is "can this still reach anyone", not "how many times did it fire". */
type SuppressionRow = {
  dailyCap: number | null;
  servedUsers24h: number;
  cappedUsers24h: number;
};
type SuppressionBySlot = Record<string, Record<string, SuppressionRow>>;

/* DID IT WORK. A click is attention, not a result — `vip_upsell` having clicks
   says nothing about whether anybody subscribed. This is whether the same
   player did the thing the campaign promotes within 24 hours of clicking:
   correlation inside a window, not proof of cause, which is why it is named
   after what it measures.

   `clicksFollowedBy` is null, never 0, where no outcome is defined for the
   campaign. A confident zero would read as "converts nobody" when the truth is
   "success is undefined here". */
type ConversionRow = {
  clicks: number;
  clicksFollowedBy: number | null;
  conversionRule: string | null;
};
type ConversionsBySlot = Record<string, Record<string, ConversionRow>>;

/* IS IT STILL WORKING. Every other figure on this page is a lifetime total, so
   a campaign that worked for three weeks and has done nothing since reads the
   same as one working today - the averages absorb the decline, and the longer
   it runs the more inertia its own history gives it. `lastEventAt` catches a
   surface that stopped dead; it says nothing about one quietly halving.

   Fourteen days, oldest first. */
type DailyRow = { day: string; impressions: number; clicks: number; viewers: number };
type DailyBySlot = Record<string, Record<string, DailyRow[]>>;

/**
 * WHAT THE RETENTION POLICY WOULD DELETE, BEFORE IT DELETES IT.
 *
 * `fn_prune_ad_events` shipped with no caller at all - a loaded delete with no
 * schedule and no preview. It cannot be scheduled here either: CLAUDE.md
 * section 11 makes Open Claw the only sanctioned scheduler and 11.3 fails CI
 * on a net-new cron route. So it belongs to the operator, and an operator is
 * owed the exact number of rows before the button, not after it.
 */
type RetentionStatus = {
  retentionDays: number;
  cutoff: string | null;
  totalEvents: number;
  prunableEvents: number;
  oldestEvent: string | null;
  newestEvent: string | null;
};

const CATEGORIES = [
  'vip',
  'diamonds',
  'spins',
  'tournaments',
  'bbj',
  'mystery_bounty',
  'referral',
  'feature',
  'club',
  'event',
  'other',
] as const;

const SLOTS = [
  { id: 'lobby_strip', label: 'Lobby Strip' },
  { id: 'session_summary', label: 'Session Summary' },
  { id: 'empty_state', label: 'Empty States' },
  { id: 'hub_promotions', label: 'Hub Promotions' },
  { id: 'table_between_hands', label: 'Table, Between Hands' },
] as const;

const AUDIENCES = [
  { id: 'all', label: 'Everyone' },
  { id: 'non_vip', label: 'Non VIP Only' },
  { id: 'vip', label: 'VIP Only' },
  { id: 'new_player', label: 'New Players (First 7 Days)' },
  { id: 'returning', label: 'Returning Players' },
] as const;

const EMPTY_FORM = {
  ad_key: '',
  category: 'feature' as string,
  headline: '',
  body: '',
  glyph: '',
  target_url: '',
  cta_label: '',
  weight: '100',
  image_url: '',
  experiment_key: '',
  slot: 'lobby_strip' as string,
  audience: 'all' as string,
  daily_cap: '',
  starts_at: '',
  ends_at: '',
};

export default function HouseAdsPage() {
  const { user } = useAuthUser();
  const isMounted = useIsMounted();

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [ads, setAds] = useState<AdRow[]>([]);
  const [placements, setPlacements] = useState<PlacementRow[]>([]);
  const [stats, setStats] = useState<Record<string, StatRow> | null>(null);
  const [statsBySlot, setStatsBySlot] = useState<StatsBySlot | null>(null);
  const [suppression, setSuppression] = useState<SuppressionBySlot | null>(null);
  const [conversions, setConversions] = useState<ConversionsBySlot | null>(null);
  const [daily, setDaily] = useState<DailyBySlot | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [pruneArmed, setPruneArmed] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [truncated, setTruncated] = useState<{
    ads: number | null;
    placements: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  /* PLACEMENT EDITING (2026-08-28). Until today a placement could be created
     with the advert and never touched: no second surface, no cap change, no
     pausing one surface while another kept running. Every multi-slot placement
     in production had been written by an agent in a migration. */
  const [placementAdId, setPlacementAdId] = useState<string | null>(null);
  const [placementDraft, setPlacementDraft] = useState({
    id: '' as string,
    slot: 'lobby_strip' as string,
    audience: 'all' as string,
    daily_cap: '' as string,
    target_url: '' as string,
  });
  const [placementBusy, setPlacementBusy] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  // ── Access ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id) {
        if (!cancelled) setAllowed(false);
        return;
      }
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle();
        if (error) throw error;
        if (!cancelled) setAllowed(['admin', 'super_admin'].includes(String(data?.role || '')));
      } catch (e) {
        reportError(e, 'HouseAdsPage.checkRole');
        // FAIL CLOSED. An unreadable role is not a grant.
        if (!cancelled) setAllowed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (allowed !== true) return;
    setLoading(true);
    setActionError(null);
    try {
      const res = await callClubArenaApi<{
        ads: AdRow[];
        placements: PlacementRow[];
        stats: Record<string, StatRow> | null;
        statsBySlot?: StatsBySlot | null;
        suppression?: SuppressionBySlot | null;
        conversions?: ConversionsBySlot | null;
        daily?: DailyBySlot | null;
        truncated?: { ads: number | null; placements: number | null } | null;
        retention?: RetentionStatus | null;
      }>('house-ads', {}, { method: 'GET' });
      if (!isMounted.current) return;
      setAds(res.ads || []);
      setPlacements(res.placements || []);
      setStats(res.stats ?? null);
      /* Optional on the wire: an older deployment of the API route does not
         send it, and the panel must degrade to the blended totals rather than
         render an empty breakdown that looks like "no views on any surface". */
      setStatsBySlot(res.statsBySlot ?? null);
      setSuppression(res.suppression ?? null);
      setConversions(res.conversions ?? null);
      setDaily(res.daily ?? null);
      setTruncated(res.truncated ?? null);
      setRetention(res.retention ?? null);
    } catch (e) {
      reportError(e, 'HouseAdsPage.load');
      if (isMounted.current) setActionError(safeErrorMessage(e, 'Could not load the ad catalog.'));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [allowed, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  const placementsByAd = useMemo(() => {
    const m = new Map<string, PlacementRow[]>();
    for (const p of placements) {
      const list = m.get(p.ad_id) || [];
      list.push(p);
      m.set(p.ad_id, list);
    }
    return m;
  }, [placements]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
  };

  const handleSave = async () => {
    if (saving) return;
    setActionError(null);
    setNotice(null);
    if (!form.headline.trim()) {
      setActionError('A headline is required.');
      return;
    }
    if (!editingId && !form.ad_key.trim()) {
      setActionError('A key is required. It is how this campaign is named in reporting.');
      return;
    }
    setSaving(true);
    try {
      let created: { placed?: boolean; warning?: string } | null = null;
      if (editingId) {
        await callClubArenaApi(
          'house-ads',
          {
            id: editingId,
            image_url: form.image_url.trim() || null,
            experiment_key: form.experiment_key.trim() || null,
            category: form.category,
            headline: form.headline,
            body: form.body,
            glyph: form.glyph,
            target_url: form.target_url,
            cta_label: form.cta_label,
            weight: form.weight,
            starts_at: form.starts_at || null,
            ends_at: form.ends_at || null,
          },
          { method: 'PATCH' }
        );
      } else {
        created = await callClubArenaApi<{ placed?: boolean; warning?: string }>(
          'house-ads',
          {
            ad_key: form.ad_key,
            category: form.category,
            headline: form.headline,
            body: form.body,
            glyph: form.glyph,
            target_url: form.target_url,
            cta_label: form.cta_label,
            weight: form.weight,
            image_url: form.image_url.trim() || null,
            experiment_key: form.experiment_key.trim() || null,
            slot: form.slot,
            audience: form.audience,
            daily_cap: form.daily_cap ? Number(form.daily_cap) : null,
            starts_at: form.starts_at || null,
            ends_at: form.ends_at || null,
          },
          { method: 'POST' }
        );
      }
      if (!isMounted.current) return;
      /* "It Is Live" must be earned, not assumed. The server tells us whether
         the placement actually landed; an ad with no placement runs NOWHERE,
         and claiming otherwise is how you publish into a void and never learn
         it. When it warns, that is the message worth reading, so it goes in
         the error banner rather than the cheerful green one. */
      if (created && created.placed === false) {
        setActionError(created.warning || 'The Ad Was Saved But Is Not Running Anywhere Yet.');
        setNotice(null);
      } else {
        setNotice(editingId ? 'Saved.' : 'Created. It Is Live In The Slot You Chose.');
      }
      resetForm();
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.save');
      if (isMounted.current) setActionError(safeErrorMessage(e, 'Could not save that ad.'));
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  // ── Placements ────────────────────────────────────────────────────────────
  const resetPlacementDraft = (slot = 'lobby_strip') =>
    setPlacementDraft({ id: '', slot, audience: 'all', daily_cap: '', target_url: '' });

  const openPlacements = (adId: string) => {
    setPlacementAdId((cur) => (cur === adId ? null : adId));
    resetPlacementDraft();
    setActionError(null);
  };

  const editPlacement = (p: PlacementRow) => {
    setPlacementDraft({
      id: p.id,
      slot: p.slot,
      audience: p.audience || 'all',
      daily_cap: p.daily_cap == null ? '' : String(p.daily_cap),
      target_url: p.target_url || '',
    });
  };

  const savePlacement = async (adId: string) => {
    setPlacementBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = {
        slot: placementDraft.slot,
        audience: placementDraft.audience,
        daily_cap: placementDraft.daily_cap === '' ? null : Number(placementDraft.daily_cap),
        /* Always sent, including as an empty string. The server keys on
           `!== undefined`, so omitting the field means "leave it alone" and an
           empty string means "clear the override and fall back to the
           campaign's own destination". Those are different instructions and an
           operator emptying the box means the second one. */
        target_url: placementDraft.target_url,
      };
      if (placementDraft.id) {
        await callClubArenaApi(
          'house-ads',
          { ...body, id: placementDraft.id },
          {
            method: 'PATCH',
            query: { kind: 'placement' },
          }
        );
      } else {
        await callClubArenaApi(
          'house-ads',
          { ...body, ad_id: adId },
          {
            method: 'POST',
            query: { kind: 'placement' },
          }
        );
      }
      resetPlacementDraft(placementDraft.slot);
      setNotice(placementDraft.id ? 'Placement Saved.' : 'Placement Added.');
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.savePlacement');
      setActionError(safeErrorMessage(e, 'Could not save that placement.'));
    } finally {
      setPlacementBusy(false);
    }
  };

  const togglePlacement = async (p: PlacementRow) => {
    setPlacementBusy(true);
    setActionError(null);
    try {
      await callClubArenaApi(
        'house-ads',
        { id: p.id, is_active: !p.is_active },
        {
          method: 'PATCH',
          query: { kind: 'placement' },
        }
      );
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.togglePlacement');
      setActionError(safeErrorMessage(e, 'Could not change that placement.'));
    } finally {
      setPlacementBusy(false);
    }
  };

  const removePlacement = async (p: PlacementRow, adLabel: string) => {
    const label = SLOTS.find((x) => x.id === p.slot)?.label || p.slot;
    const ok = await confirmDialog({
      title: 'Remove This Placement',
      message: `"${adLabel}" Will Stop Running On ${label}. The Ad Itself Is Kept.`,
      confirmText: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setPlacementBusy(true);
    setActionError(null);
    try {
      /* The API tells us when this was the LAST placement, because an ad with
         none runs nowhere and looks perfectly healthy in the list. */
      const res = await callClubArenaApi<{ orphaned?: boolean }>(
        'house-ads',
        {},
        { method: 'DELETE', query: { kind: 'placement', id: p.id } }
      );
      setNotice(
        res?.orphaned ? 'Placement Removed. That Ad Now Runs Nowhere.' : 'Placement Removed.'
      );
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.removePlacement');
      setActionError(safeErrorMessage(e, 'Could not remove that placement.'));
    } finally {
      setPlacementBusy(false);
    }
  };

  /**
   * THE ONLY CALLER fn_prune_ad_events HAS.
   *
   * Two deliberate properties:
   *
   * 1. The COUNT IS SHOWN BEFORE THE BUTTON, and the button carries it. An
   *    operator should never learn the size of a delete from its result.
   * 2. NO "how many days" input. The server reads the policy itself, so the
   *    number in the confirmation and the number the delete uses cannot
   *    drift apart between the render and the click.
   *
   * The disarm on refusal matters too: leaving it armed means the next stray
   * click deletes, which is precisely the slow-afternoon accident.
   */
  const pruneEvents = async () => {
    if (!retention || retention.prunableEvents <= 0) return;
    const ok = await confirmDialog({
      title: 'Prune Old Ad Events',
      message: `${retention.prunableEvents.toLocaleString()} Events Older Than ${retention.retentionDays} Days Will Be Deleted Permanently. Reporting Older Than The Cutoff Will Go With Them.`,
      confirmText: 'Prune',
      variant: 'danger',
    });
    if (!ok) {
      setPruneArmed(false);
      return;
    }
    setPruneBusy(true);
    setActionError(null);
    try {
      const res = await callClubArenaApi<{ deleted?: number }>(
        'house-ads',
        {},
        { method: 'POST', query: { kind: 'prune' } }
      );
      const n = Number(res?.deleted) || 0;
      /* "0 Deleted" is a real and useful answer - it means another operator or
         an earlier run got there first - so it is reported rather than
         swallowed as a no-op. */
      setNotice(`${n.toLocaleString()} Old Events Pruned.`);
      setPruneArmed(false);
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.pruneEvents');
      setActionError(safeErrorMessage(e, 'Could not prune those events.'));
    } finally {
      setPruneBusy(false);
    }
  };

  const handleToggle = async (ad: AdRow) => {
    setActionError(null);
    try {
      await callClubArenaApi(
        'house-ads',
        { id: ad.id, is_active: !ad.is_active },
        { method: 'PATCH' }
      );
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.toggle');
      if (isMounted.current) setActionError(safeErrorMessage(e, 'Could not change that ad.'));
    }
  };

  const handleEdit = (ad: AdRow) => {
    /* image_url and experiment_key are catalog fields, so unlike slot/audience
       /cap they ARE editable - the form shows them in both modes. */
    setEditingId(ad.id);
    setForm({
      ad_key: ad.ad_key,
      category: ad.category,
      headline: ad.headline || '',
      body: ad.body || '',
      glyph: ad.glyph || '',
      target_url: ad.target_url || '',
      cta_label: ad.cta_label || '',
      weight: String(ad.weight ?? 100),
      image_url: ad.image_url || '',
      experiment_key: ad.experiment_key || '',
      slot: 'lobby_strip',
      audience: 'all',
      daily_cap: '',
      starts_at: ad.starts_at ? ad.starts_at.slice(0, 16) : '',
      ends_at: ad.ends_at ? ad.ends_at.slice(0, 16) : '',
    });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (ad: AdRow) => {
    const ok = await confirmDialog({
      title: 'Delete This Ad?',
      message: `"${ad.headline}" And Its Performance History Will Be Removed. This Cannot Be Undone.`,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setActionError(null);
    try {
      await callClubArenaApi('house-ads', {}, { method: 'DELETE', query: { id: ad.id } });
      await load();
    } catch (e) {
      reportError(e, 'HouseAdsPage.delete');
      if (isMounted.current) setActionError(safeErrorMessage(e, 'Could not delete that ad.'));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (allowed === null) {
    return (
      <div className="admin-dashboard-page__admin-page">
        <div className="admin-container">
          <div className="admin-skeleton" style={{ height: 40, marginBottom: 12 }} />
          <div className="admin-skeleton" style={{ height: 120 }} />
        </div>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="admin-dashboard-page__admin-page">
        <div className="admin-container">
          <div className="admin-error-banner">
            ACCESS DENIED: House Ads Are Managed By Smarter.Poker Staff. Club Owners Can Post To
            Their Own Players From Admin, Announce.
          </div>
        </div>
      </div>
    );
  }

  /* Eighths, because a sparkline made of block characters needs no canvas, no
     library and no layout, and this panel is a dense table where a real chart
     would cost more than it explains. Flat at the top when every day is equal:
     a scale that shows noise as a mountain is worse than no chart. */
  const sparkline = (values: number[]) => {
    const bars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
    const max = Math.max(...values, 0);
    if (max <= 0) return bars[0].repeat(values.length);
    return values
      .map((v) => bars[Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)))])
      .join('');
  };

  const rate = (s: StatRow | undefined) => {
    if (!s || s.impressions === 0) return '-';
    return `${((s.clicks / s.impressions) * 100).toFixed(1)}%`;
  };

  return (
    <div className="admin-dashboard-page__admin-page">
      <div className="admin-container">
        <div className="admin-page-header">
          <h1 className="admin-page-title">House Ads</h1>
          <p className="admin-text-secondary">
            Smarter.Poker Promotions. These Run In Every Club Lobby, Below A Club's Own Notices.
          </p>
        </div>

        {actionError && <div className="admin-error-banner">{actionError}</div>}
        {notice && <div className="admin-success-banner">{notice}</div>}

        {/* ── Composer ── */}
        <div className="admin-card">
          <h2 className="admin-card-title">{editingId ? 'Edit Ad' : 'New Ad'}</h2>

          <div style={{ display: 'grid', gap: 12 }}>
            {!editingId && (
              <div>
                <label className="admin-label" htmlFor="ad-key">
                  Key
                </label>
                <input
                  id="ad-key"
                  className="admin-dashboard-page__admin-input"
                  value={form.ad_key}
                  placeholder="spring_spins_push"
                  onChange={(e) => setForm((f) => ({ ...f, ad_key: e.target.value }))}
                />
                <div className="admin-text-secondary" style={{ fontSize: 12, marginTop: 4 }}>
                  How This Campaign Is Named In Reporting. Lower Case, No Spaces.
                </div>
              </div>
            )}

            <div>
              <label className="admin-label" htmlFor="ad-headline">
                Headline
              </label>
              <input
                id="ad-headline"
                className="admin-dashboard-page__admin-input"
                maxLength={120}
                value={form.headline}
                placeholder="Spins Pay Up To 1000X"
                onChange={(e) => setForm((f) => ({ ...f, headline: e.target.value }))}
              />
            </div>

            <div>
              <label className="admin-label" htmlFor="ad-body">
                Body
              </label>
              <textarea
                id="ad-body"
                className="admin-textarea"
                rows={2}
                maxLength={240}
                value={form.body}
                placeholder="One Line. The Strip Shows A Single Row On A Phone."
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 12,
              }}
            >
              <div>
                <label className="admin-label" htmlFor="ad-category">
                  Category
                </label>
                <select
                  id="ad-category"
                  className="admin-dashboard-page__admin-input"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="admin-label" htmlFor="ad-glyph">
                  Glyph
                </label>
                <input
                  id="ad-glyph"
                  className="admin-dashboard-page__admin-input"
                  maxLength={4}
                  value={form.glyph}
                  placeholder="◉"
                  onChange={(e) => setForm((f) => ({ ...f, glyph: e.target.value }))}
                />
                <div className="admin-text-secondary" style={{ fontSize: 12, marginTop: 4 }}>
                  A Symbol, Not An Emoji.
                </div>
              </div>

              <div>
                <label className="admin-label" htmlFor="ad-weight">
                  Weight
                </label>
                <input
                  id="ad-weight"
                  className="admin-dashboard-page__admin-input"
                  /* min={1}, not 0: the database refuses a zero weight
                     (ad_catalog_weight_positive), so a 0 here was a save that
                     came back "Could not create that ad" without ever naming
                     the field that caused it. */
                  type="number"
                  min={1}
                  max={1000}
                  value={form.weight}
                  onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
                />
                <div className="admin-text-secondary" style={{ fontSize: 12, marginTop: 4 }}>
                  Higher Wins The Slot.
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
              }}
            >
              <div>
                <label className="admin-label" htmlFor="ad-target">
                  Links To
                </label>
                <input
                  id="ad-target"
                  className="admin-dashboard-page__admin-input"
                  value={form.target_url}
                  placeholder="/vip"
                  onChange={(e) => setForm((f) => ({ ...f, target_url: e.target.value }))}
                />
              </div>
              <div>
                <label className="admin-label" htmlFor="ad-cta">
                  Button Text
                </label>
                <input
                  id="ad-cta"
                  className="admin-dashboard-page__admin-input"
                  maxLength={40}
                  value={form.cta_label}
                  placeholder="See VIP"
                  onChange={(e) => setForm((f) => ({ ...f, cta_label: e.target.value }))}
                />
              </div>
            </div>

            {/* IMAGE AND EXPERIMENT are catalog fields, so they show in BOTH
                modes - unlike surface, audience and cap below, which belong to
                a PLACEMENT and are managed in the Placements row of the table.
                Putting them in the create-only block would have made an
                existing campaign's image uneditable, which is the same shape as
                the gap this whole change is fixing. */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
              }}
            >
              <div>
                <label className="admin-label" htmlFor="ad-image">
                  Image Path (Optional)
                </label>
                <input
                  id="ad-image"
                  className="admin-dashboard-page__admin-input"
                  placeholder="/images/promo.png"
                  value={form.image_url}
                  onChange={(e) => setForm((f) => ({ ...f, image_url: e.target.value }))}
                />
                <div className="admin-text-secondary" style={{ fontSize: 11, marginTop: 4 }}>
                  A Path On This Site Only. An Outside Address Sends Player Device Details To
                  Somebody Else.
                </div>
              </div>
              <div>
                <label className="admin-label" htmlFor="ad-experiment">
                  Experiment Key (Optional)
                </label>
                <input
                  id="ad-experiment"
                  className="admin-dashboard-page__admin-input"
                  placeholder="spins_headline_test"
                  value={form.experiment_key}
                  onChange={(e) => setForm((f) => ({ ...f, experiment_key: e.target.value }))}
                />
                <div className="admin-text-secondary" style={{ fontSize: 11, marginTop: 4 }}>
                  Two Ads Sharing A Key Are Variants Of One Test. Traffic Splits Between Them By
                  Weight.
                </div>
              </div>
            </div>

            {!editingId && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 12,
                }}
              >
                <div>
                  <label className="admin-label" htmlFor="ad-slot">
                    Where
                  </label>
                  <select
                    id="ad-slot"
                    className="admin-dashboard-page__admin-input"
                    value={form.slot}
                    onChange={(e) => setForm((f) => ({ ...f, slot: e.target.value }))}
                  >
                    {SLOTS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="admin-label" htmlFor="ad-audience">
                    Who Sees It
                  </label>
                  <select
                    id="ad-audience"
                    className="admin-dashboard-page__admin-input"
                    value={form.audience}
                    onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))}
                  >
                    {AUDIENCES.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="admin-label" htmlFor="ad-cap">
                    Views Per Player Per Day
                  </label>
                  <input
                    id="ad-cap"
                    className="admin-dashboard-page__admin-input"
                    type="number"
                    min={1}
                    value={form.daily_cap}
                    placeholder="Uncapped"
                    onChange={(e) => setForm((f) => ({ ...f, daily_cap: e.target.value }))}
                  />
                </div>
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: 12,
              }}
            >
              <div>
                <label className="admin-label" htmlFor="ad-start">
                  Starts
                </label>
                <input
                  id="ad-start"
                  className="admin-dashboard-page__admin-input"
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))}
                />
              </div>
              <div>
                <label className="admin-label" htmlFor="ad-end">
                  Ends
                </label>
                <input
                  id="ad-end"
                  className="admin-dashboard-page__admin-input"
                  type="datetime-local"
                  value={form.ends_at}
                  onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="admin-btn admin-btn-primary"
                disabled={saving}
                onClick={handleSave}
              >
                {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Ad'}
              </button>
              {editingId && (
                <button type="button" className="admin-btn admin-btn-ghost" onClick={resetForm}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── The catalog ── */}
        <div className="admin-card">
          <h2 className="admin-card-title">Running Now</h2>

          {stats === null && !loading && (
            <div className="admin-text-secondary" style={{ fontSize: 12, marginBottom: 10 }}>
              Performance Could Not Be Read, So The Numbers Below Show A Dash Rather Than Zero.
            </div>
          )}

          {/* A SUBSET SAYS SO (2026-08-28). The catalog read stops at 200 rows
              and the placement read at 1,000. Those ceilings are fine - loading
              ten thousand rows into an editor helps nobody - but until now the
              page would simply stop mentioning anything past them and look
              complete. Same shape as the 50,000-row stats ceiling that was
              silently under-counting until it was removed. */}
          {!loading && truncated && (truncated.ads || truncated.placements) ? (
            <div className="admin-badge-yellow" style={{ fontSize: 12, marginBottom: 10 }}>
              Showing Part Of The List Only
              {truncated.ads ? `: ${ads.length} Of ${truncated.ads} Campaigns` : ''}
              {truncated.placements
                ? `${truncated.ads ? ', ' : ': '}${placements.length} Of ${truncated.placements} Placements`
                : ''}
              . Performance Figures Cover Everything; The Rows Below Do Not.
            </div>
          ) : null}

          {/* ── RETENTION ────────────────────────────────────────────────────
              fn_prune_ad_events shipped with NO CALLER: a permanent delete
              with no schedule, no preview and no way to reach it. Open Claw is
              the only sanctioned scheduler here (CLAUDE.md 11) and a net-new
              cron route fails CI (11.3), so the honest home for it is the
              operator's hands - with the blast radius stated first.

              The button carries the count. Nobody should learn the size of a
              delete from its result. And when there is nothing to prune the
              control is absent rather than disabled, because a dead button on
              a destructive action invites the experimental click that finds
              out what it does. */}
          {!loading && retention ? (
            <div
              className="admin-panel-soft"
              style={{
                fontSize: 12,
                marginBottom: 10,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span>
                Event Retention: {retention.retentionDays} Days.{' '}
                {retention.totalEvents.toLocaleString()} Events Stored
                {retention.oldestEvent
                  ? `, Oldest ${new Date(retention.oldestEvent).toLocaleDateString()}`
                  : ''}
                .
              </span>
              {retention.prunableEvents > 0 ? (
                <>
                  <span className="admin-badge-yellow">
                    {retention.prunableEvents.toLocaleString()} Past The Cutoff
                  </span>
                  {pruneArmed ? (
                    <>
                      <button
                        type="button"
                        className="admin-btn-danger"
                        onClick={() => void pruneEvents()}
                        disabled={pruneBusy}
                      >
                        {pruneBusy
                          ? 'Pruning...'
                          : `Delete ${retention.prunableEvents.toLocaleString()} Events`}
                      </button>
                      <button
                        type="button"
                        className="admin-btn-ghost"
                        onClick={() => setPruneArmed(false)}
                        disabled={pruneBusy}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="admin-btn-ghost"
                      onClick={() => setPruneArmed(true)}
                    >
                      Prune Old Events
                    </button>
                  )}
                </>
              ) : (
                <span style={{ opacity: 0.7 }}>Nothing Past The Cutoff.</span>
              )}
            </div>
          ) : null}

          {loading ? (
            <>
              <div className="admin-skeleton" style={{ height: 36, marginBottom: 8 }} />
              <div className="admin-skeleton" style={{ height: 36, marginBottom: 8 }} />
              <div className="admin-skeleton" style={{ height: 36 }} />
            </>
          ) : ads.length === 0 ? (
            <div className="admin-empty-state">
              <span className="admin-empty-icon">◉</span>
              <div>No House Ads Yet. Create One Above.</div>
            </div>
          ) : (
            <div className="admin-table-scroll">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>Ad</th>
                    <th>Where</th>
                    <th>Views</th>
                    <th>Clicks</th>
                    <th>Rate</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ads.map((ad) => {
                    const s = stats?.[ad.id];
                    const pls = placementsByAd.get(ad.id) || [];
                    return (
                      <Fragment key={ad.id}>
                        <tr>
                          <td>
                            <div style={{ fontWeight: 700 }}>
                              {ad.glyph ? `${ad.glyph} ` : ''}
                              {ad.headline}
                            </div>
                            <div
                              className="admin-text-secondary admin-mono"
                              style={{ fontSize: 11 }}
                            >
                              {ad.ad_key} &middot; {ad.category.replace(/_/g, ' ')} &middot; weight{' '}
                              {ad.weight}
                            </div>
                          </td>
                          <td className="admin-text-secondary" style={{ fontSize: 12 }}>
                            {pls.length === 0 ? (
                              /* An ad with no placement runs NOWHERE. That is the
                               commonest way to publish something and see
                               nothing happen, so it is called out rather than
                               left as an empty cell. */
                              <span className="admin-badge-yellow">Not Placed</span>
                            ) : (
                              /* PER SURFACE, NOT BLENDED (2026-08-28). Each
                               placement carries its own numbers, because one
                               campaign on four surfaces used to report a
                               single total that could not tell an operator
                               which surface was carrying it and which was
                               dragging it down.

                               A placement with no events yet reads "No Views
                               Yet" rather than 0/0, and an unreadable rollup
                               still reads as a dash - a confident zero is the
                               lie this whole panel exists to avoid. */
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {pls.map((p) => {
                                  const label = SLOTS.find((x) => x.id === p.slot)?.label || p.slot;
                                  const ss = statsBySlot?.[ad.id]?.[p.slot];
                                  const sup = suppression?.[ad.id]?.[p.slot];
                                  const conv = conversions?.[ad.id]?.[p.slot];
                                  const series = daily?.[ad.id]?.[p.slot];
                                  return (
                                    <div key={p.id}>
                                      <span>{label}</span>
                                      {p.audience && p.audience !== 'all' ? (
                                        <span className="admin-text-secondary">
                                          {' '}
                                          ({p.audience})
                                        </span>
                                      ) : null}
                                      <span className="admin-mono" style={{ marginLeft: 6 }}>
                                        {statsBySlot === null
                                          ? '-'
                                          : ss
                                            ? `${ss.impressions} Views To ${ss.viewers ?? '?'} ${
                                                ss.viewers === 1 ? 'Person' : 'People'
                                              } / ${ss.clicks} (${rate(ss)})`
                                            : 'No Views Yet'}
                                      </span>
                                      {/* Why it might be quiet. Only shown when
                                        somebody is actually capped out: a "0
                                        Capped" on every row would be noise, and
                                        the number only means something next to
                                        the number it is a fraction of. */}
                                      {/* THE LAST FOURTEEN DAYS, drawn in eighths.
                                        A trend is the one thing a lifetime
                                        total cannot show, and a campaign that
                                        is halving looks healthy right up until
                                        somebody plots it. Only drawn with two
                                        or more days: a single bar is not a
                                        trend, it is a number wearing one. */}
                                      {series && series.length > 1 ? (
                                        <span
                                          className="admin-mono"
                                          style={{ marginLeft: 6, letterSpacing: '-1px' }}
                                          title={series
                                            .map(
                                              (d) =>
                                                `${d.day}: ${d.impressions} views, ${d.clicks} clicks`
                                            )
                                            .join('\n')}
                                          aria-label={`Last ${series.length} Days Of Views`}
                                        >
                                          {sparkline(series.map((d) => d.impressions))}
                                        </span>
                                      ) : null}
                                      {/* Did it work. Only shown once the
                                        placement has clicks to judge - a
                                        conversion line under a placement with
                                        no clicks is arithmetic on nothing. */}
                                      {conv && conv.clicks > 0 ? (
                                        <span
                                          className="admin-text-secondary"
                                          style={{ marginLeft: 6, fontSize: 11 }}
                                          title={
                                            conv.conversionRule
                                              ? `${conv.conversionRule}, Within 24 Hours Of The Click. Correlation, Not Proof Of Cause.`
                                              : 'No Outcome Is Defined For This Campaign, So This Is Deliberately Not Counted'
                                          }
                                        >
                                          {conv.clicksFollowedBy === null
                                            ? 'No Outcome Defined'
                                            : `${conv.clicksFollowedBy} Followed Through`}
                                        </span>
                                      ) : null}
                                      {sup && sup.cappedUsers24h > 0 ? (
                                        <span
                                          className="admin-badge-yellow"
                                          style={{ marginLeft: 6, fontSize: 10 }}
                                          title="Players Who Have Already Hit This Placement's Daily Cap In The Last 24 Hours, And So Cannot See It Again Today"
                                        >
                                          {sup.cappedUsers24h} Of {sup.servedUsers24h} Capped Out
                                        </span>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                          <td className="admin-mono">
                            {stats === null ? '-' : (s?.impressions ?? 0)}
                          </td>
                          <td className="admin-mono">{stats === null ? '-' : (s?.clicks ?? 0)}</td>
                          <td className="admin-mono">{stats === null ? '-' : rate(s)}</td>
                          <td>
                            <span className={ad.is_active ? 'admin-badge-green' : 'admin-badge'}>
                              {ad.is_active ? 'Live' : 'Paused'}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className="admin-btn admin-btn-sm admin-btn-ghost"
                                onClick={() => handleEdit(ad)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="admin-btn admin-btn-sm admin-btn-ghost"
                                onClick={() => openPlacements(ad.id)}
                                aria-expanded={placementAdId === ad.id}
                              >
                                {placementAdId === ad.id ? 'Close' : 'Placements'}
                              </button>
                              <button
                                type="button"
                                className="admin-btn admin-btn-sm admin-btn-ghost"
                                onClick={() => handleToggle(ad)}
                              >
                                {ad.is_active ? 'Pause' : 'Resume'}
                              </button>
                              <button
                                type="button"
                                className="admin-btn admin-btn-sm admin-btn-danger"
                                onClick={() => handleDelete(ad)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* WHERE A CAMPAIGN RUNS, AND HOW TO MOVE IT
                          (2026-08-28). This row is the whole point of the
                          change: before it, a placement was created with the
                          advert and never touched again, so "run this on the
                          Hub too" or "lower that cap" meant an agent writing a
                          migration. */}
                        {placementAdId === ad.id ? (
                          <tr>
                            <td colSpan={7} style={{ background: 'rgba(255,255,255,0.02)' }}>
                              <div style={{ padding: '6px 2px 10px' }}>
                                <div
                                  className="admin-text-secondary"
                                  style={{ fontSize: 11, marginBottom: 8 }}
                                >
                                  Where This Ad Runs. An Ad With No Placement Runs Nowhere.
                                </div>

                                {pls.length === 0 ? (
                                  <div className="admin-badge-yellow" style={{ fontSize: 12 }}>
                                    Not Placed. This Ad Is Running Nowhere.
                                  </div>
                                ) : (
                                  <table className="admin-table" style={{ marginBottom: 10 }}>
                                    <thead>
                                      <tr>
                                        <th>Surface</th>
                                        <th>Who</th>
                                        <th>Cap</th>
                                        <th>Links To</th>
                                        <th>State</th>
                                        {/* Named, not empty: a header cell with
                                          no text is a column a screen reader
                                          announces as nothing at all. */}
                                        <th aria-label="Actions" />
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {pls.map((p) => (
                                        <tr key={p.id}>
                                          <td>
                                            {SLOTS.find((x) => x.id === p.slot)?.label || p.slot}
                                          </td>
                                          <td className="admin-text-secondary">
                                            {AUDIENCES.find((a) => a.id === (p.audience || 'all'))
                                              ?.label || p.audience}
                                            {/* A club-scoped placement runs in one
                                              club only. Nothing had ever used
                                              this, which is exactly when a typo
                                              goes unnoticed - so it is labelled
                                              rather than left blank. */}
                                            {p.club_id ? ' - One Club Only' : ''}
                                          </td>
                                          <td className="admin-mono">
                                            {p.daily_cap == null
                                              ? 'Uncapped'
                                              : `${p.daily_cap}/Day`}
                                          </td>
                                          {/* WHERE THIS SURFACE ACTUALLY SENDS
                                            THE PLAYER. fn_resolve_ads serves
                                            COALESCE(pl.target_url,
                                            c.target_url), so an override here
                                            beats the campaign's own Links To -
                                            and eight live placements had one
                                            that this panel neither showed nor
                                            could change. Blank is not empty, it
                                            inherited, and it says so. */}
                                          <td className="admin-mono">
                                            {p.target_url ? (
                                              p.target_url
                                            ) : (
                                              <span className="admin-text-secondary">
                                                Inherited From The Ad
                                              </span>
                                            )}
                                          </td>
                                          <td>
                                            <span
                                              className={
                                                p.is_active ? 'admin-badge-green' : 'admin-badge'
                                              }
                                            >
                                              {p.is_active ? 'Live' : 'Paused'}
                                            </span>
                                          </td>
                                          <td>
                                            <div style={{ display: 'flex', gap: 6 }}>
                                              <button
                                                type="button"
                                                className="admin-btn admin-btn-sm admin-btn-ghost"
                                                disabled={placementBusy}
                                                onClick={() => editPlacement(p)}
                                              >
                                                Edit
                                              </button>
                                              <button
                                                type="button"
                                                className="admin-btn admin-btn-sm admin-btn-ghost"
                                                disabled={placementBusy}
                                                onClick={() => togglePlacement(p)}
                                              >
                                                {p.is_active ? 'Pause' : 'Resume'}
                                              </button>
                                              <button
                                                type="button"
                                                className="admin-btn admin-btn-sm admin-btn-danger"
                                                disabled={placementBusy}
                                                onClick={() => removePlacement(p, ad.headline)}
                                              >
                                                Remove
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}

                                <div
                                  style={{
                                    display: 'flex',
                                    gap: 8,
                                    alignItems: 'flex-end',
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <div>
                                    <label className="admin-label" htmlFor={`pl-slot-${ad.id}`}>
                                      Surface
                                    </label>
                                    <select
                                      id={`pl-slot-${ad.id}`}
                                      className="admin-dashboard-page__admin-input"
                                      value={placementDraft.slot}
                                      onChange={(e) =>
                                        setPlacementDraft((d) => ({ ...d, slot: e.target.value }))
                                      }
                                    >
                                      {SLOTS.map((x) => (
                                        <option key={x.id} value={x.id}>
                                          {x.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="admin-label" htmlFor={`pl-aud-${ad.id}`}>
                                      Who Sees It
                                    </label>
                                    <select
                                      id={`pl-aud-${ad.id}`}
                                      className="admin-dashboard-page__admin-input"
                                      value={placementDraft.audience}
                                      onChange={(e) =>
                                        setPlacementDraft((d) => ({
                                          ...d,
                                          audience: e.target.value,
                                        }))
                                      }
                                    >
                                      {AUDIENCES.map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="admin-label" htmlFor={`pl-cap-${ad.id}`}>
                                      Views Per Player Per Day
                                    </label>
                                    <input
                                      id={`pl-cap-${ad.id}`}
                                      className="admin-dashboard-page__admin-input"
                                      type="number"
                                      min={1}
                                      placeholder="Uncapped"
                                      value={placementDraft.daily_cap}
                                      onChange={(e) =>
                                        setPlacementDraft((d) => ({
                                          ...d,
                                          daily_cap: e.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                  {/* THE OVERRIDE, EDITABLE AT LAST. Left empty
                                    the placement inherits the campaign's own
                                    Links To, which is what the placeholder says.
                                    Emptying a box that had a value is a real
                                    edit and clears the override - savePlacement
                                    sends the empty string for exactly that. */}
                                  <div style={{ minWidth: 180 }}>
                                    <label className="admin-label" htmlFor={`pl-target-${ad.id}`}>
                                      Links To On This Surface
                                    </label>
                                    <input
                                      id={`pl-target-${ad.id}`}
                                      className="admin-dashboard-page__admin-input"
                                      type="text"
                                      placeholder="Inherited From The Ad"
                                      value={placementDraft.target_url}
                                      onChange={(e) =>
                                        setPlacementDraft((d) => ({
                                          ...d,
                                          target_url: e.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    className="admin-btn admin-btn-sm"
                                    disabled={placementBusy}
                                    onClick={() => savePlacement(ad.id)}
                                  >
                                    {placementBusy
                                      ? 'Saving...'
                                      : placementDraft.id
                                        ? 'Save Placement'
                                        : 'Add Placement'}
                                  </button>
                                  {placementDraft.id ? (
                                    <button
                                      type="button"
                                      className="admin-btn admin-btn-sm admin-btn-ghost"
                                      disabled={placementBusy}
                                      onClick={() => resetPlacementDraft()}
                                    >
                                      Cancel
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
