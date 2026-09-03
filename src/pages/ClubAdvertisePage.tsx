/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB ADVERTISE PAGE - a club owner buys a picture on a surface, in diamonds
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03: club owners "start advertising their club or events
 * (using diamonds)". This is the whole buyer's side: the rate card, the
 * exact creative size each surface needs, a live preview in the surface's
 * true shape, the price in diamonds before anything is charged, one Submit,
 * and the list of what this club has bought with its live numbers.
 *
 * Nothing here decides money. The preview and the total are a courtesy; the
 * database recomputes the price, checks the folder, checks the destination
 * and takes the diamonds in one transaction (`fn_club_ad_submit`). A campaign
 * is reviewed by the house before it runs; a rejection is refunded.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { confirmDialog } from '../components/common/confirmDialog';
import PageSkeleton from '../components/common/PageSkeleton';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { formatDate } from '../utils/format';
import { AdCampaignService } from '../services/AdCampaignService';
import type { AdCampaign, AdRateCard } from '../services/AdCampaignService';
import type { AdSlot } from '../services/AdService';
import { AD_SURFACE_RATIO } from '../components/ads/HouseAdRotator';
import './ClubAdvertisePage.css';

const DESTINATIONS: { key: string; label: string; path: (clubId: string) => string }[] = [
  { key: 'lobby', label: 'Club Lobby', path: (id) => `/clubs/${id}/lobby` },
  { key: 'tournaments', label: 'Club Tournaments', path: (id) => `/clubs/${id}/tournaments` },
  { key: 'announcements', label: 'Club Announcements', path: (id) => `/clubs/${id}/announcements` },
];

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Awaiting Review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  live: 'Live',
  finished: 'Finished',
  rejected: 'Not Approved',
  cancelled: 'Cancelled',
};

function fmt(n: number): string {
  return n.toLocaleString();
}

export default function ClubAdvertisePage() {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [clubId, setClubId] = useState<string | null>(null);
  const [clubName, setClubName] = useState('');
  const [isStaff, setIsStaff] = useState<boolean | null>(null);
  const [rates, setRates] = useState<AdRateCard[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── The form ──────────────────────────────────────────────────────────────
  const [slot, setSlot] = useState<AdSlot>('lobby_strip');
  const [headline, setHeadline] = useState('');
  const [destination, setDestination] = useState('lobby');
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState<'platform' | 'own_club'>('platform');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rate = useMemo(() => rates.find((r) => r.slot === slot) ?? null, [rates, slot]);
  const openRates = useMemo(() => rates.filter((r) => r.isOpen), [rates]);
  const cost = rate ? rate.diamondsPerDay * days : 0;
  const canAfford = balance === null ? true : balance >= cost;

  const load = useCallback(async () => {
    if (!routeClubId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const resolved = await resolveClubUUID(routeClubId);
      setClubId(resolved);
      const [{ data: club }, staffRes, rateCard] = await Promise.all([
        supabase.from('clubs').select('name').eq('id', resolved).maybeSingle(),
        supabase.rpc('fn_club_is_staff', { p_club_id: resolved, p_user_id: user?.id ?? null }),
        AdCampaignService.rateCard(),
      ]);
      setClubName(club?.name ?? '');
      /* Fail closed: an unreadable role is not evidence of staff. */
      setIsStaff(staffRes.error ? false : Boolean(staffRes.data));
      setRates(rateCard);
      const firstOpen = rateCard.find((r) => r.isOpen);
      if (firstOpen && !rateCard.some((r) => r.slot === slot && r.isOpen)) setSlot(firstOpen.slot);
      if (!staffRes.error && staffRes.data) {
        setCampaigns(await AdCampaignService.list(resolved));
      }
      if (user?.id) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('diamonds')
          .eq('id', user.id)
          .maybeSingle();
        setBalance(prof?.diamonds == null ? null : Number(prof.diamonds));
      }
    } catch (e) {
      reportError(e, 'ClubAdvertisePage.load');
      setLoadError(safeErrorMessage(e, 'This Page Could Not Load'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeClubId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Creative preview in the surface's true shape ──────────────────────────
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onPickFile = (f: File | null) => {
    setFileError(null);
    setFile(f);
  };

  const submit = async () => {
    if (!clubId || !rate || !file) return;
    const dest = DESTINATIONS.find((d) => d.key === destination) ?? DESTINATIONS[0];
    const ok = await confirmDialog({
      title: 'Buy This Advert?',
      message: `${fmt(cost)} Diamonds For ${days} Day(s) On The ${rate.label}. The House Reviews Every Advert Before It Runs, And A Rejected Advert Is Refunded In Full.`,
      confirmText: 'Pay And Submit',
      cancelText: 'Not Yet',
    });
    if (!ok) return;
    setBusy(true);
    setFileError(null);
    try {
      const imageUrl = await AdCampaignService.uploadCreative(clubId, slot, file, rate);
      const res = await AdCampaignService.submit({
        clubId,
        slot,
        headline: headline.trim(),
        imageUrl,
        targetUrl: dest.path(clubId),
        startsAt: new Date(),
        days,
        scope,
      });
      if (!res.ok) {
        const why: Record<string, string> = {
          not_club_staff: 'Only Club Staff Can Buy Adverts',
          surface_not_open: 'That Surface Is Not Open To Clubs Right Now',
          days_out_of_range: `Choose Between ${res.minDays ?? 1} And ${res.maxDays ?? 30} Days`,
          creative_not_in_club_folder: 'The Picture Did Not Land In Your Club Folder. Try Again',
          bad_destination: 'That Destination Is Not On This Site',
          bad_headline: 'Give The Advert A Short Headline',
          debit_failed:
            res.detail === 'Insufficient diamonds'
              ? 'Not Enough Diamonds'
              : `Payment Did Not Go Through: ${res.detail ?? 'Unknown'}`,
        };
        toast.error(why[res.reason] ?? `Could Not Submit: ${res.reason}`);
        return;
      }
      toast.success(
        `Submitted. ${fmt(res.diamondsCharged)} Diamonds Charged. The House Will Review It Shortly`
      );
      if (res.balance != null) setBalance(res.balance);
      setFile(null);
      setHeadline('');
      setCampaigns(await AdCampaignService.list(clubId));
    } catch (e) {
      const msg = safeErrorMessage(e, 'Could Not Submit');
      setFileError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (c: AdCampaign) => {
    const ok = await confirmDialog({
      title: 'Withdraw This Advert?',
      message: `${fmt(c.diamondsCharged)} Diamonds Come Back To Your Balance.`,
      confirmText: 'Withdraw',
      cancelText: 'Keep It',
    });
    if (!ok || !clubId) return;
    const res = await AdCampaignService.cancel(c.id);
    if (!res.ok) {
      toast.error(
        res.reason === 'not_cancellable'
          ? 'That Advert Has Already Been Reviewed'
          : 'Could Not Withdraw'
      );
      return;
    }
    toast.success(`Withdrawn. ${fmt(res.diamondsRefunded ?? c.diamondsCharged)} Diamonds Refunded`);
    setBalance((b) => (b == null ? b : b + (res.diamondsRefunded ?? c.diamondsCharged)));
    setCampaigns(await AdCampaignService.list(clubId));
  };

  if (loading) return <PageSkeleton />;

  if (loadError) {
    return (
      <div className="club-advertise">
        <div className="club-advertise__error">
          {loadError}
          <button type="button" className="club-advertise__btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isStaff === false) {
    return (
      <div className="club-advertise">
        <div className="club-advertise__error">
          Only Club Staff Can Buy Adverts For This Club.
          <button type="button" className="club-advertise__btn" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const headlineOk = headline.trim().length > 0 && headline.trim().length <= 120;
  const canSubmit = Boolean(
    rate &&
    file &&
    headlineOk &&
    !busy &&
    canAfford &&
    days >= (rate?.minDays ?? 1) &&
    days <= (rate?.maxDays ?? 30)
  );

  return (
    <div className="club-advertise">
      <header className="club-advertise__head">
        <button
          type="button"
          className="club-advertise__back"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          {'‹'}
        </button>
        <div>
          <h1 className="club-advertise__title">Advertise {clubName || 'Your Club'}</h1>
          <p className="club-advertise__sub">
            Put A Picture In Front Of Every Player On Smarter.Poker. Pay In Diamonds. The House
            Reviews Every Advert Before It Runs.
          </p>
        </div>
        <div className="club-advertise__balance" aria-label="Your Diamonds">
          <span className="diamond-icon" aria-hidden="true" />
          <span>{balance == null ? '-' : fmt(balance)}</span>
        </div>
      </header>

      {/* ── Rate card ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">Where It Runs</h2>
        <div className="club-advertise__surfaces">
          {openRates.map((r) => (
            <button
              key={r.slot}
              type="button"
              className={`club-advertise__surface${r.slot === slot ? ' club-advertise__surface--on' : ''}`}
              onClick={() => {
                setSlot(r.slot);
                setFile(null);
                setFileError(null);
              }}
              aria-pressed={r.slot === slot}
            >
              <span
                className="club-advertise__surface-shape"
                style={{ aspectRatio: AD_SURFACE_RATIO[r.slot] }}
                aria-hidden="true"
              />
              <span className="club-advertise__surface-label">{r.label}</span>
              <span className="club-advertise__surface-price">
                <span className="diamond-icon" aria-hidden="true" />
                {fmt(r.diamondsPerDay)} Per Day
              </span>
              <span className="club-advertise__surface-size">
                {`${r.creativeWidth} x ${r.creativeHeight}`}
              </span>
            </button>
          ))}
        </div>
        {rate ? <p className="club-advertise__blurb">{rate.blurb}</p> : null}
      </section>

      {/* ── The creative ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">Your Picture</h2>
        {rate ? (
          <p className="club-advertise__hint">
            Exactly {`${rate.creativeWidth} x ${rate.creativeHeight}`} Pixels, WebP, PNG Or JPEG,
            Under {Math.round(rate.maxBytes / 1024)} KB. It Scales With The Page And Is Never
            Cropped.
          </p>
        ) : null}
        <div
          className="club-advertise__preview"
          style={{ aspectRatio: rate ? AD_SURFACE_RATIO[rate.slot] : '6 / 1' }}
        >
          {preview ? (
            <img src={preview} alt="Your Advert Preview" />
          ) : (
            <span className="club-advertise__preview-empty">Preview Appears Here</span>
          )}
        </div>
        <label className="club-advertise__file">
          <input
            type="file"
            accept="image/webp,image/png,image/jpeg"
            onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <span className="club-advertise__btn club-advertise__btn--ghost">
            {file ? 'Choose A Different Picture' : 'Choose A Picture'}
          </span>
          {file ? <span className="club-advertise__file-name">{file.name}</span> : null}
        </label>
        {fileError ? <div className="club-advertise__field-error">{fileError}</div> : null}
      </section>

      {/* ── The flight ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">The Details</h2>
        <div className="club-advertise__grid">
          <label className="club-advertise__field">
            <span>Headline</span>
            <input
              type="text"
              maxLength={120}
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Sunday Deepstack, 10K Guaranteed"
              disabled={busy}
            />
            <small>
              Read Aloud By Screen Readers And Shown In Your Reports. Not Drawn On The Picture.
            </small>
          </label>
          <label className="club-advertise__field">
            <span>Tapping It Opens</span>
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              disabled={busy}
            >
              {DESTINATIONS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="club-advertise__field">
            <span>Days</span>
            <input
              type="number"
              min={rate?.minDays ?? 1}
              max={rate?.maxDays ?? 30}
              value={days}
              onChange={(e) =>
                setDays(Math.max(1, Math.min(rate?.maxDays ?? 30, Number(e.target.value) || 1)))
              }
              disabled={busy}
            />
            <small>Starts As Soon As The House Approves It.</small>
          </label>
          <label className="club-advertise__field">
            <span>Who Sees It</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value === 'own_club' ? 'own_club' : 'platform')}
              disabled={busy}
            >
              <option value="platform">Every Player On Smarter.Poker</option>
              <option value="own_club">Only Players Inside This Club</option>
            </select>
          </label>
        </div>

        <div className="club-advertise__total">
          <div>
            <span className="club-advertise__total-label">Total</span>
            <span className="club-advertise__total-value">
              <span className="diamond-icon" aria-hidden="true" />
              {fmt(cost)}
            </span>
            <span className="club-advertise__total-math">
              {rate ? `${fmt(rate.diamondsPerDay)} x ${days} Day(s)` : ''}
            </span>
          </div>
          <button
            type="button"
            className="club-advertise__btn club-advertise__btn--primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? 'Submitting' : 'Pay And Submit'}
          </button>
        </div>
        {!canAfford ? (
          <div className="club-advertise__field-error">Not Enough Diamonds For This Flight.</div>
        ) : null}
      </section>

      {/* ── What this club has bought ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">Your Adverts</h2>
        {campaigns.length === 0 ? (
          <p className="club-advertise__hint">
            Nothing Yet. The First One Appears Here The Moment You Submit It.
          </p>
        ) : (
          <ul className="club-advertise__list">
            {campaigns.map((c) => (
              <li key={c.id} className="club-advertise__item">
                <div
                  className="club-advertise__item-picture"
                  style={{ aspectRatio: AD_SURFACE_RATIO[c.slot] }}
                >
                  <img src={c.imageUrl} alt={c.headline} loading="lazy" />
                </div>
                <div className="club-advertise__item-body">
                  <div className="club-advertise__item-top">
                    <strong>{c.headline}</strong>
                    <span
                      className={`club-advertise__status club-advertise__status--${c.displayStatus}`}
                    >
                      {STATUS_LABEL[c.displayStatus] ?? c.displayStatus}
                    </span>
                  </div>
                  <div className="club-advertise__item-meta">
                    {rates.find((r) => r.slot === c.slot)?.label ?? c.slot} {'·'} {c.days} Day(s){' '}
                    {'·'} {formatDate(c.startsAt)} To {formatDate(c.endsAt)} {'·'}{' '}
                    <span className="diamond-icon" aria-hidden="true" />
                    {fmt(c.diamondsCharged)}
                    {c.diamondsRefunded > 0 ? ` (${fmt(c.diamondsRefunded)} Refunded)` : ''}
                  </div>
                  {c.reviewNote ? (
                    <div className="club-advertise__item-note">
                      Note From The House: {c.reviewNote}
                    </div>
                  ) : null}
                  {c.status === 'approved' ? (
                    <div className="club-advertise__item-stats">
                      <span>{fmt(c.viewers)} People</span>
                      <span>{fmt(c.impressions)} Shown</span>
                      <span>{fmt(c.viewable)} Seen</span>
                      <span>{fmt(c.clicks)} Taps</span>
                    </div>
                  ) : null}
                  {c.status === 'submitted' ? (
                    <button
                      type="button"
                      className="club-advertise__btn club-advertise__btn--ghost club-advertise__btn--sm"
                      onClick={() => void cancel(c)}
                    >
                      Withdraw And Refund
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
