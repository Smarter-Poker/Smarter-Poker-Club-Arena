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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
type SlotStatRow = StatRow & { lastEventAt: string | null };
type StatsBySlot = Record<string, Record<string, SlotStatRow>>;

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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
      }>('house-ads', {}, { method: 'GET' });
      if (!isMounted.current) return;
      setAds(res.ads || []);
      setPlacements(res.placements || []);
      setStats(res.stats ?? null);
      /* Optional on the wire: an older deployment of the API route does not
         send it, and the panel must degrade to the blended totals rather than
         render an empty breakdown that looks like "no views on any surface". */
      setStatsBySlot(res.statsBySlot ?? null);
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
      message: `"${ad.headline}" and its performance history will be removed. This cannot be undone.`,
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
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-skeleton" style={{ height: 40, marginBottom: 12 }} />
          <div className="admin-skeleton" style={{ height: 120 }} />
        </div>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-error-banner">
            ACCESS DENIED: House Ads Are Managed By Smarter.Poker Staff. Club Owners Can Post To
            Their Own Players From Admin, Announce.
          </div>
        </div>
      </div>
    );
  }

  const rate = (s: StatRow | undefined) => {
    if (!s || s.impressions === 0) return '-';
    return `${((s.clicks / s.impressions) * 100).toFixed(1)}%`;
  };

  return (
    <div className="admin-page">
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
                  className="admin-input"
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
                className="admin-input"
                maxLength={120}
                value={form.headline}
                placeholder="Spins Pay Up To 1000x"
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
                  className="admin-input"
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
                  className="admin-input"
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
                  className="admin-input"
                  type="number"
                  min={0}
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
                  className="admin-input"
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
                  className="admin-input"
                  maxLength={40}
                  value={form.cta_label}
                  placeholder="See VIP"
                  onChange={(e) => setForm((f) => ({ ...f, cta_label: e.target.value }))}
                />
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
                    className="admin-input"
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
                    className="admin-input"
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
                    className="admin-input"
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
                  className="admin-input"
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
                  className="admin-input"
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
                      <tr key={ad.id}>
                        <td>
                          <div style={{ fontWeight: 700 }}>
                            {ad.glyph ? `${ad.glyph} ` : ''}
                            {ad.headline}
                          </div>
                          <div className="admin-text-secondary admin-mono" style={{ fontSize: 11 }}>
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
                                return (
                                  <div key={p.id}>
                                    <span>{label}</span>
                                    {p.audience && p.audience !== 'all' ? (
                                      <span className="admin-text-secondary"> ({p.audience})</span>
                                    ) : null}
                                    <span className="admin-mono" style={{ marginLeft: 6 }}>
                                      {statsBySlot === null
                                        ? '-'
                                        : ss
                                          ? `${ss.impressions} / ${ss.clicks} (${rate(ss)})`
                                          : 'No Views Yet'}
                                    </span>
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
