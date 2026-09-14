/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ADVERTISE PAGE - a club buys a picture in diamonds; a sponsor books one
 *  and is invoiced. One page, two modes, one review queue.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03: club owners "start advertising their club or events
 * (using diamonds)" and "allow others to advertise with us". Dan, 2026-09-13:
 * every advert is a fluid picture and a tap opens it full screen - so every
 * flight booked here carries TWO pictures: the surface creative in the
 * surface's shape, and a 3:4 poster for the popup.
 *
 * CLUB MODE (`/clubs/:clubId/advertise`): the rate card, the exact creative
 * size each surface needs, a live preview in the surface's true shape, the
 * price in diamonds before anything is charged, one Submit, and the list of
 * what this club has bought with its live numbers. The database recomputes
 * the price, checks both folders, checks the destination and takes the
 * diamonds in one transaction (`fn_club_ad_submit`).
 *
 * SPONSOR MODE (`/advertise`): the same page for an outside advertiser who
 * signed in. They open their advertiser once (`fn_sponsor_advertiser_upsert`),
 * upload into their own folder, give the https address their advert sends
 * players to, and submit (`fn_sponsor_ad_submit`). No diamonds move: a
 * sponsor is invoiced off platform by a person, and the page says so instead
 * of inventing a price. The address never reaches a player's browser - the
 * resolver serves `/c/<code>` and the redirect counts the click.
 *
 * Both land `submitted` in the one queue staff review, and both read their
 * own numbers here (`fn_ad_campaign_report`, opened to the advertiser's owner
 * on 2026-09-13).
 *
 * Dress: this family (advertise, campaign queue) is not yet on the
 * #ClubArenaConsole master - the sweep works in traffic order and operator
 * pages are last. The sponsor mode reuses the club page's dress so the family
 * is rebuilt once, together, when its turn comes.
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
import {
  AdCampaignService,
  POSTER_SHAPE,
  billingLabel,
  countriesLabel,
  formatDollars,
  parseCountries,
} from '../services/AdCampaignService';
import type {
  AdCampaign,
  AdCampaignDay,
  AdRateCard,
  SponsorAdvertiser,
} from '../services/AdCampaignService';
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

/* The one surface nothing renders yet. A sponsor cannot book it (the RPC
   refuses too); a club cannot because its rate card row is closed. */
const UNBUILT_SLOTS: AdSlot[] = ['table_between_hands'];

const POSTER_RATIO = `${POSTER_SHAPE.width} / ${POSTER_SHAPE.height}`;

function fmt(n: number): string {
  return n.toLocaleString();
}

/** A same-site path or an https address, checked the way the RPC checks it. */
function isHttpsAddress(v: string): boolean {
  const s = v.trim();
  return /^https:\/\/[a-zA-Z0-9]/.test(s) && s.length >= 12 && s.length <= 500 && !/\s/.test(s);
}

export interface ClubAdvertisePageProps {
  /** `club` buys in diamonds for a club; `sponsor` books for an outside advertiser. */
  mode?: 'club' | 'sponsor';
}

export default function ClubAdvertisePage({ mode = 'club' }: ClubAdvertisePageProps) {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const sponsorMode = mode === 'sponsor';

  const [clubId, setClubId] = useState<string | null>(null);
  const [clubName, setClubName] = useState('');
  const [isStaff, setIsStaff] = useState<boolean | null>(null);
  const [rates, setRates] = useState<AdRateCard[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── The sponsor's advertiser (sponsor mode) ───────────────────────────────
  const [advertiser, setAdvertiser] = useState<SponsorAdvertiser | null>(null);
  const [advName, setAdvName] = useState('');
  const [advEmail, setAdvEmail] = useState('');
  const [advBusy, setAdvBusy] = useState(false);

  // ── The form ──────────────────────────────────────────────────────────────
  const [slot, setSlot] = useState<AdSlot>('lobby_strip');
  const [headline, setHeadline] = useState('');
  const [destination, setDestination] = useState('lobby');
  const [externalUrl, setExternalUrl] = useState('');
  const [countriesText, setCountriesText] = useState('');
  const [days, setDays] = useState(7);
  const [scope, setScope] = useState<'platform' | 'own_club'>('platform');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [poster, setPoster] = useState<File | null>(null);
  const [posterPreview, setPosterPreview] = useState<string | null>(null);
  const [posterError, setPosterError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Day by day, one campaign open at a time ───────────────────────────────
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [report, setReport] = useState<AdCampaignDay[] | null>(null);
  const [reportFailure, setReportFailure] = useState<string | null>(null);

  const rate = useMemo(() => rates.find((r) => r.slot === slot) ?? null, [rates, slot]);
  /* A club books the surfaces open to clubs. A sponsor may book any priced
     surface something renders; the house decides at review. */
  const bookableRates = useMemo(
    () =>
      rates.filter((r) =>
        sponsorMode ? !UNBUILT_SLOTS.includes(r.slot) && r.sponsorCentsPerDay > 0 : r.isOpen
      ),
    [rates, sponsorMode]
  );
  const cost = rate ? rate.diamondsPerDay * days : 0;
  /* A sponsor's price, in cents, from the same rate card the RPC freezes onto
     the flight. The page shows it; the database is the authority. */
  const quoteCents = rate ? rate.sponsorCentsPerDay * days : 0;
  const canAfford = sponsorMode || balance === null ? true : balance >= cost;

  const reloadCampaigns = useCallback(async () => {
    if (sponsorMode) {
      setCampaigns(await AdCampaignService.sponsorList());
    } else if (clubId) {
      setCampaigns(await AdCampaignService.list(clubId));
    }
  }, [sponsorMode, clubId]);

  const load = useCallback(async () => {
    if (!sponsorMode && !routeClubId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const rateCard = await AdCampaignService.rateCard();
      setRates(rateCard);
      const bookable = rateCard.filter((r) =>
        sponsorMode ? !UNBUILT_SLOTS.includes(r.slot) && r.sponsorCentsPerDay > 0 : r.isOpen
      );
      if (bookable.length && !bookable.some((r) => r.slot === slot)) setSlot(bookable[0].slot);

      if (sponsorMode) {
        const mine = await AdCampaignService.sponsorMine();
        setAdvertiser(mine);
        if (mine) {
          setAdvName(mine.name);
          setAdvEmail(mine.contactEmail ?? '');
          setCampaigns(await AdCampaignService.sponsorList());
        }
        setIsStaff(true);
        return;
      }

      const resolved = await resolveClubUUID(routeClubId as string);
      setClubId(resolved);
      const [clubRes, staffRes] = await Promise.all([
        supabase.from('clubs').select('name').eq('id', resolved).maybeSingle(),
        supabase.rpc('fn_club_is_staff', { p_club_id: resolved, p_user_id: user?.id ?? null }),
      ]);
      /* An unreadable name is not an empty name. The heading falls back to
         "Your Club" either way, but the read that failed is reported rather
         than left to look like a club with no name. */
      if (clubRes.error) reportError(clubRes.error, 'ClubAdvertisePage.clubName');
      setClubName(clubRes.data?.name ?? '');
      /* Fail closed: an unreadable role is not evidence of staff. */
      setIsStaff(staffRes.error ? false : Boolean(staffRes.data));
      if (!staffRes.error && staffRes.data) {
        setCampaigns(await AdCampaignService.list(resolved));
      }
      if (user?.id) {
        /* This page spends diamonds, so a balance that could not be read is
           reported and shown as a dash - never as a zero, and never quietly
           as "you can afford this". `canAfford` treats null as "we do not
           know", which lets the buyer try; the debit itself is the
           authority and answers Not Enough Diamonds if it is short. */
        const { data: prof, error: profErr } = await supabase
          .from('profiles')
          .select('diamonds')
          .eq('id', user.id)
          .maybeSingle();
        if (profErr) reportError(profErr, 'ClubAdvertisePage.balance');
        setBalance(profErr || prof?.diamonds == null ? null : Number(prof.diamonds));
      }
    } catch (e) {
      reportError(e, 'ClubAdvertisePage.load');
      setLoadError(safeErrorMessage(e, 'This Page Could Not Load'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeClubId, user?.id, sponsorMode]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Previews in each picture's true shape ─────────────────────────────────
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!poster) {
      setPosterPreview(null);
      return;
    }
    const url = URL.createObjectURL(poster);
    setPosterPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [poster]);

  const onPickFile = (f: File | null) => {
    setFileError(null);
    setFile(f);
  };

  const onPickPoster = (f: File | null) => {
    setPosterError(null);
    setPoster(f);
  };

  const saveAdvertiser = async () => {
    setAdvBusy(true);
    try {
      const res = await AdCampaignService.sponsorUpsert(advName.trim(), advEmail.trim() || null);
      if (!res.ok) {
        const why: Record<string, string> = {
          not_signed_in: 'Sign In To Advertise',
          bad_advertiser_name: 'Give Your Business A Name',
          bad_contact_email: 'That Contact Email Does Not Look Right',
        };
        toast.error(why[res.reason] ?? `Could Not Save: ${res.reason}`);
        return;
      }
      toast.success(advertiser ? 'Saved' : 'Welcome. Book Your First Advert Below');
      setAdvertiser(await AdCampaignService.sponsorMine());
      await reloadCampaigns();
    } catch (e) {
      toast.error(safeErrorMessage(e, 'Could Not Save'));
    } finally {
      setAdvBusy(false);
    }
  };

  const submit = async () => {
    if (!rate || !file || !poster) return;
    if (sponsorMode ? !advertiser : !clubId) return;
    const ok = await confirmDialog(
      sponsorMode
        ? {
            title: 'Book This Advert?',
            message: `${formatDollars(quoteCents)} For ${days} Day(s) On The ${rate.label}, Sending Players To ${externalUrl.trim()}. Smarter.Poker Reviews Every Advert Before It Runs And Invoices You Once It Is Approved. Nothing Is Charged Here.`,
            confirmText: 'Book It',
            cancelText: 'Not Yet',
          }
        : {
            title: 'Buy This Advert?',
            message: `${fmt(cost)} Diamonds For ${days} Day(s) On The ${rate.label}. The House Reviews Every Advert Before It Runs, And A Rejected Advert Is Refunded In Full.`,
            confirmText: 'Pay And Submit',
            cancelText: 'Not Yet',
          }
    );
    if (!ok) return;
    setBusy(true);
    setFileError(null);
    setPosterError(null);
    try {
      if (sponsorMode && advertiser) {
        let imageUrl: string;
        let posterUrl: string;
        try {
          imageUrl = await AdCampaignService.sponsorUploadCreative(
            advertiser.advertiserId,
            slot,
            file,
            rate
          );
        } catch (e) {
          setFileError(safeErrorMessage(e, 'The Picture Could Not Be Uploaded'));
          throw e;
        }
        try {
          posterUrl = await AdCampaignService.sponsorUploadPoster(advertiser.advertiserId, poster);
        } catch (e) {
          setPosterError(safeErrorMessage(e, 'The Poster Could Not Be Uploaded'));
          throw e;
        }
        const res = await AdCampaignService.sponsorSubmit({
          slot,
          headline: headline.trim(),
          imageUrl,
          posterUrl,
          externalUrl: externalUrl.trim(),
          startsAt: new Date(),
          days,
          countries: parseCountries(countriesText) ?? null,
        });
        if (!res.ok) {
          const why: Record<string, string> = {
            not_signed_in: 'Sign In To Advertise',
            no_advertiser: 'Save Your Business Details First',
            advertiser_suspended: 'Your Advertising Account Is Paused. Contact Smarter.Poker',
            bad_headline: 'Give The Advert A Short Headline',
            unknown_slot: 'That Surface Cannot Be Booked',
            surface_not_for_sale: 'That Surface Is Not For Sale Right Now',
            bad_days: 'Choose Between 1 And 365 Days',
            creative_not_in_your_folder: 'The Picture Did Not Land In Your Folder. Try Again',
            poster_not_in_your_folder: 'The Poster Did Not Land In Your Folder. Try Again',
            destination_must_be_https: 'The Address Must Start With https://',
            bad_goal: 'The Impression Goal Must Be A Whole Number Above Zero',
            bad_pacing: 'Pacing Must Be Even Or Asap',
          };
          toast.error(why[res.reason] ?? `Could Not Book: ${res.reason}`);
          return;
        }
        toast.success(
          `Booked At ${formatDollars(quoteCents)}. Smarter.Poker Will Review It And Invoice You Once It Is Approved`
        );
      } else if (clubId) {
        const dest = DESTINATIONS.find((d) => d.key === destination) ?? DESTINATIONS[0];
        let imageUrl: string;
        let posterUrl: string;
        try {
          imageUrl = await AdCampaignService.uploadCreative(clubId, slot, file, rate);
        } catch (e) {
          setFileError(safeErrorMessage(e, 'The Picture Could Not Be Uploaded'));
          throw e;
        }
        try {
          posterUrl = await AdCampaignService.uploadPoster(clubId, poster);
        } catch (e) {
          setPosterError(safeErrorMessage(e, 'The Poster Could Not Be Uploaded'));
          throw e;
        }
        const res = await AdCampaignService.submit({
          clubId,
          slot,
          headline: headline.trim(),
          imageUrl,
          posterUrl,
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
            poster_not_in_club_folder: 'The Poster Did Not Land In Your Club Folder. Try Again',
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
      }
      setFile(null);
      setPoster(null);
      setHeadline('');
      await reloadCampaigns();
    } catch (e) {
      const msg = safeErrorMessage(e, 'Could Not Submit');
      if (!fileError && !posterError) setFileError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (c: AdCampaign) => {
    const ok = await confirmDialog({
      title: 'Withdraw This Advert?',
      message: sponsorMode
        ? 'It Comes Out Of The Review Queue. Nothing Was Charged.'
        : `${fmt(c.diamondsCharged)} Diamonds Come Back To Your Balance.`,
      confirmText: 'Withdraw',
      cancelText: 'Keep It',
    });
    if (!ok) return;
    const res = await AdCampaignService.cancel(c.id);
    if (!res.ok) {
      toast.error(
        res.reason === 'not_cancellable'
          ? 'That Advert Has Already Been Reviewed'
          : 'Could Not Withdraw'
      );
      return;
    }
    if (sponsorMode) {
      toast.success('Withdrawn');
    } else {
      toast.success(
        `Withdrawn. ${fmt(res.diamondsRefunded ?? c.diamondsCharged)} Diamonds Refunded`
      );
      setBalance((b) => (b == null ? b : b + (res.diamondsRefunded ?? c.diamondsCharged)));
    }
    await reloadCampaigns();
  };

  /* Day by day for one flight. Computed on read; a closed panel forgets it,
     and an unreadable report says so rather than showing an empty table. */
  const toggleReport = async (c: AdCampaign) => {
    if (reportFor === c.id) {
      setReportFor(null);
      setReport(null);
      setReportFailure(null);
      return;
    }
    setReportFor(c.id);
    setReport(null);
    setReportFailure(null);
    try {
      setReport(await AdCampaignService.report(c.id));
    } catch (e) {
      setReportFailure(safeErrorMessage(e, 'The Day By Day Numbers Could Not Be Read'));
    }
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
  const destinationOk = sponsorMode ? isHttpsAddress(externalUrl) : true;
  const countriesOk = sponsorMode ? parseCountries(countriesText) !== undefined : true;
  const advertiserOk = sponsorMode ? Boolean(advertiser && advertiser.status === 'active') : true;
  const canSubmit = Boolean(
    rate &&
    file &&
    poster &&
    headlineOk &&
    destinationOk &&
    countriesOk &&
    advertiserOk &&
    !busy &&
    canAfford &&
    days >= (sponsorMode ? 1 : (rate?.minDays ?? 1)) &&
    days <= (sponsorMode ? 365 : (rate?.maxDays ?? 30))
  );
  const advertiserFormOk = advName.trim().length > 0 && advName.trim().length <= 80 && !advBusy;

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
          <h1 className="club-advertise__title">
            {sponsorMode ? 'Advertise On Smarter.Poker' : `Advertise ${clubName || 'Your Club'}`}
          </h1>
          <p className="club-advertise__sub">
            {sponsorMode
              ? 'Put A Picture In Front Of Every Player On Smarter.Poker, Sending Them To Your Own Site. Priced Per Day, Reviewed Before It Runs, Invoiced Once Approved.'
              : 'Put A Picture In Front Of Every Player On Smarter.Poker. Pay In Diamonds. The House Reviews Every Advert Before It Runs.'}
          </p>
        </div>
        {sponsorMode ? null : (
          <div className="club-advertise__balance" aria-label="Your Diamonds">
            <span className="diamond-icon" aria-hidden="true" />
            <span>{balance == null ? '-' : fmt(balance)}</span>
          </div>
        )}
      </header>

      {/* ── Who is advertising (sponsor mode) ── */}
      {sponsorMode ? (
        <section className="club-advertise__card">
          <h2 className="club-advertise__h2">Your Business</h2>
          {advertiser?.status === 'suspended' ? (
            <div className="club-advertise__field-error">
              Your Advertising Account Is Paused. Contact Smarter.Poker To Resume.
            </div>
          ) : null}
          <div className="club-advertise__grid">
            <label className="club-advertise__field">
              <span>Business Name</span>
              <input
                type="text"
                maxLength={80}
                value={advName}
                onChange={(e) => setAdvName(e.target.value)}
                placeholder="Acme Poker Supplies"
                disabled={advBusy}
              />
              <small>Shown On The Popup As Sponsored By, So Players Know Who Is Speaking.</small>
            </label>
            <label className="club-advertise__field">
              <span>Contact Email (Optional)</span>
              <input
                type="email"
                maxLength={200}
                value={advEmail}
                onChange={(e) => setAdvEmail(e.target.value)}
                placeholder="ads@acme.example"
                disabled={advBusy}
              />
              <small>Where Smarter.Poker Sends The Invoice And Any Questions.</small>
            </label>
          </div>
          <div className="club-advertise__total">
            <div>
              <span className="club-advertise__total-label">
                {advertiser ? 'Advertising As' : 'Not Set Up Yet'}
              </span>
              <span className="club-advertise__total-math">{advertiser?.name ?? ''}</span>
            </div>
            <button
              type="button"
              className="club-advertise__btn club-advertise__btn--primary"
              onClick={() => void saveAdvertiser()}
              disabled={!advertiserFormOk}
            >
              {advBusy ? 'Saving' : advertiser ? 'Save' : 'Start Advertising'}
            </button>
          </div>
        </section>
      ) : null}

      {/* ── Rate card ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">Where It Runs</h2>
        <div className="club-advertise__surfaces">
          {bookableRates.map((r) => (
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
              {sponsorMode ? (
                <span className="club-advertise__surface-price">
                  {formatDollars(r.sponsorCentsPerDay)} Per Day
                </span>
              ) : (
                <span className="club-advertise__surface-price">
                  <span className="diamond-icon" aria-hidden="true" />
                  {fmt(r.diamondsPerDay)} Per Day
                </span>
              )}
              <span className="club-advertise__surface-size">
                {`${r.creativeWidth} By ${r.creativeHeight}`}
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
            Exactly {`${rate.creativeWidth} By ${rate.creativeHeight}`} Pixels, WebP, PNG Or JPEG,
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

      {/* ── The poster: what a tap opens, full screen ── */}
      <section className="club-advertise__card">
        <h2 className="club-advertise__h2">Your Poster</h2>
        <p className="club-advertise__hint">
          When A Player Taps Your Advert It Opens Full Screen As This Poster, With One Button That
          Goes Where You Point. Exactly {`${POSTER_SHAPE.width} By ${POSTER_SHAPE.height}`} Pixels,
          Under {Math.round(POSTER_SHAPE.maxBytes / 1024)} KB.
        </p>
        <div
          className="club-advertise__preview club-advertise__preview--poster"
          style={{ aspectRatio: POSTER_RATIO }}
        >
          {posterPreview ? (
            <img src={posterPreview} alt="Your Poster Preview" />
          ) : (
            <span className="club-advertise__preview-empty">Poster Appears Here</span>
          )}
        </div>
        <label className="club-advertise__file">
          <input
            type="file"
            accept="image/webp,image/png,image/jpeg"
            onChange={(e) => onPickPoster(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <span className="club-advertise__btn club-advertise__btn--ghost">
            {poster ? 'Choose A Different Poster' : 'Choose A Poster'}
          </span>
          {poster ? <span className="club-advertise__file-name">{poster.name}</span> : null}
        </label>
        {posterError ? <div className="club-advertise__field-error">{posterError}</div> : null}
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
              placeholder={
                sponsorMode ? 'Free Shipping On Every Chip Set' : 'Sunday Deepstack, 10K Guaranteed'
              }
              disabled={busy}
            />
            <small>
              Read Aloud By Screen Readers, Printed Under The Poster, And Shown In Your Reports. Not
              Drawn On The Picture.
            </small>
          </label>
          {sponsorMode ? (
            <>
              <label className="club-advertise__field">
                <span>The Button Sends Players To</span>
                <input
                  type="url"
                  maxLength={500}
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                  placeholder="https://acme.example/poker"
                  disabled={busy}
                  inputMode="url"
                />
                <small>
                  A Full HTTPS Address On Your Own Site. It Opens In A New Tab And Never Leaves A
                  Player Signed Out.
                </small>
              </label>
              <label className="club-advertise__field">
                <span>Countries (Optional)</span>
                <input
                  type="text"
                  maxLength={200}
                  value={countriesText}
                  onChange={(e) => setCountriesText(e.target.value)}
                  placeholder="Leave Empty For Everywhere, Or US, CA, GB"
                  disabled={busy}
                  autoCapitalize="characters"
                />
                <small>
                  {countriesOk
                    ? `Shown ${countriesLabel(parseCountries(countriesText))}. A Player Whose Location Is Unknown Never Sees A Country-Limited Advert.`
                    : 'Two-Letter Country Codes Only, Separated By Commas: US, CA, GB.'}
                </small>
              </label>
            </>
          ) : (
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
          )}
          <label className="club-advertise__field">
            <span>Days</span>
            <input
              type="number"
              min={sponsorMode ? 1 : (rate?.minDays ?? 1)}
              max={sponsorMode ? 365 : (rate?.maxDays ?? 30)}
              value={days}
              onChange={(e) =>
                setDays(
                  Math.max(
                    1,
                    Math.min(sponsorMode ? 365 : (rate?.maxDays ?? 30), Number(e.target.value) || 1)
                  )
                )
              }
              disabled={busy}
            />
            <small>Starts As Soon As The House Approves It.</small>
          </label>
          {sponsorMode ? null : (
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
          )}
        </div>

        <div className="club-advertise__total">
          {sponsorMode ? (
            <div>
              <span className="club-advertise__total-label">Total</span>
              <span className="club-advertise__total-value">{formatDollars(quoteCents)}</span>
              <span className="club-advertise__total-math">
                {rate ? `${formatDollars(rate.sponsorCentsPerDay)} x ${days} Day(s)` : ''}
                {' · '}Invoiced By Smarter.Poker Once Approved. Nothing Is Charged Here.
              </span>
            </div>
          ) : (
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
          )}
          <button
            type="button"
            className="club-advertise__btn club-advertise__btn--primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? 'Submitting' : sponsorMode ? 'Book It' : 'Pay And Submit'}
          </button>
        </div>
        {!canAfford ? (
          <div className="club-advertise__field-error">Not Enough Diamonds For This Flight.</div>
        ) : null}
        {sponsorMode && !advertiser ? (
          <div className="club-advertise__hint">Save Your Business Details Above First.</div>
        ) : null}
      </section>

      {/* ── What this advertiser has bought ── */}
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
                    {'·'} {formatDate(c.startsAt)} To {formatDate(c.endsAt)}
                    {sponsorMode ? (
                      c.quotedCents != null ? (
                        <>
                          {' '}
                          {'·'} {formatDollars(c.quotedCents)} {billingLabel(c)}
                          {c.countries ? (
                            <>
                              {' '}
                              {'·'} {countriesLabel(c.countries)}
                            </>
                          ) : null}
                        </>
                      ) : null
                    ) : (
                      <>
                        {' '}
                        {'·'} <span className="diamond-icon" aria-hidden="true" />
                        {fmt(c.diamondsCharged)}
                        {c.diamondsRefunded > 0 ? ` (${fmt(c.diamondsRefunded)} Refunded)` : ''}
                      </>
                    )}
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
                  {c.status === 'approved' ? (
                    <button
                      type="button"
                      className="club-advertise__btn club-advertise__btn--ghost club-advertise__btn--sm"
                      onClick={() => void toggleReport(c)}
                      aria-expanded={reportFor === c.id}
                    >
                      {reportFor === c.id ? 'Hide Day By Day' : 'Day By Day'}
                    </button>
                  ) : null}
                  {reportFor === c.id ? (
                    reportFailure ? (
                      <div className="club-advertise__field-error">{reportFailure}</div>
                    ) : report == null ? (
                      <div className="club-advertise__hint">Reading</div>
                    ) : report.length === 0 ? (
                      <div className="club-advertise__hint">No Days To Show Yet.</div>
                    ) : (
                      <table className="club-advertise__days">
                        <thead>
                          <tr>
                            <th scope="col">Day</th>
                            <th scope="col">People</th>
                            <th scope="col">Shown</th>
                            <th scope="col">Seen</th>
                            <th scope="col">Taps</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.map((d) => (
                            <tr key={d.day}>
                              <td>{formatDate(d.day)}</td>
                              <td>{fmt(d.viewers)}</td>
                              <td>{fmt(d.impressions)}</td>
                              <td>{fmt(d.viewable)}</td>
                              <td>{fmt(d.clicks)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  ) : null}
                  {c.status === 'submitted' ? (
                    <button
                      type="button"
                      className="club-advertise__btn club-advertise__btn--ghost club-advertise__btn--sm"
                      onClick={() => void cancel(c)}
                    >
                      {sponsorMode ? 'Withdraw' : 'Withdraw And Refund'}
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
