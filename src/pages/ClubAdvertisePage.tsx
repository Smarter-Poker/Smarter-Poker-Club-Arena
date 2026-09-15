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
 * Dress: #ClubArenaConsole since 2026-09-14. One console per section, each
 * cut from an approved master and wearing its own crest; the sponsor mode
 * reuses the club page's dress, so both were rebuilt together. The campaign
 * queue staff read (components/ads/CampaignQueue) is the other half of this
 * family and is still to come.
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
import { SpadeConsole } from '../components/console/SpadeConsole';
import { titleCase } from '../utils/titleCase';
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

  /* ═══════════════════════════════════════════════════════════════════════
     ON THE CONSOLE (#ClubArenaConsole, 2026-09-14)
     ═══════════════════════════════════════════════════════════════════════
     The file header used to say this family "is not yet on the master - the
     sweep works in traffic order and operator pages are last". Its turn came.

     Re-rendered, not rewritten: every RPC, every upload, every refusal
     sentence, every confirm dialog, `canSubmit`, `canAfford`, the countries
     check and the day-by-day report are the ones that were here.

     ONE CONSOLE PER SECTION, each cut from an approved master and wearing its
     own crest - a page of six identical frames is the cookie-cutter Dan
     refused on 2026-09-13. Gone with the markup that carried them: thirteen
     corner radii, four gradients, the round back chevron, the bordered
     surface tiles, the dashed preview boxes, the pill-shaped ghost buttons,
     the amber AWAITING REVIEW badge and every `club-advertise__card` panel.
     Nothing here draws a control; the fields and the two picture previews are
     the only drawn things, because no master paints a form.

     THE STATUS BADGE LOST ITS AMBER. "Awaiting Review" was a warm pill on a
     page whose schema has no yellow; it is a lit word in the master's own ink
     now, and the state decides which ink. */
  if (loading) return <PageSkeleton />;

  if (loadError) {
    return (
      <div className="club-advertise">
        <SpadeConsole
          className="club-advertise__console"
          crest="flat"
          eyebrow="Advertise"
          title="Could Not Load"
          foot="foot"
        >
          <p className="club-advertise__copy">{loadError}</p>
          <div className="club-advertise__words">
            <button
              type="button"
              className="club-advertise__word sc-ink--white"
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        </SpadeConsole>
      </div>
    );
  }

  if (isStaff === false) {
    return (
      <div className="club-advertise">
        <SpadeConsole
          className="club-advertise__console"
          crest="flat"
          eyebrow="Advertise"
          title="Staff Only"
          foot="foot"
        >
          <p className="club-advertise__copy">Only Club Staff Can Buy Adverts For This Club.</p>
          <div className="club-advertise__words">
            <button
              type="button"
              className="club-advertise__word sc-ink--white"
              onClick={() => navigate(-1)}
            >
              Back
            </button>
          </div>
        </SpadeConsole>
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
      {/* ── The page head ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="diamond"
        eyebrow="Advertise"
        title={sponsorMode ? 'Smarter.Poker' : clubName || 'Your Club'}
        pill={sponsorMode ? 'Sponsor' : 'Club'}
        pillInk="blue"
        foot="foot"
      >
        <p className="club-advertise__copy">
          {sponsorMode
            ? 'Put A Picture In Front Of Every Player On Smarter.Poker, Sending Them To Your Own Site. Priced Per Day, Reviewed Before It Runs, Invoiced Once Approved.'
            : 'Put A Picture In Front Of Every Player On Smarter.Poker. Pay In Diamonds. The House Reviews Every Advert Before It Runs.'}
        </p>
        {sponsorMode ? null : (
          <div className="club-advertise__row" aria-label="Your Diamonds">
            <span className="club-advertise__label sc-ink--blue">Your Diamonds</span>
            {/* Never a zero when the read failed: a dash says "we do not know",
                and `canAfford` treats null the same way. */}
            <span className="club-advertise__value sc-ink--gold">
              {balance == null ? '-' : fmt(balance)}
            </span>
          </div>
        )}
        <div className="club-advertise__words">
          <button
            type="button"
            className="club-advertise__word sc-ink--muted"
            onClick={() => navigate(-1)}
            aria-label="Back"
          >
            Back
          </button>
        </div>
      </SpadeConsole>

      {/* ── Who is advertising (sponsor mode) ── */}
      {sponsorMode ? (
        <SpadeConsole
          className="club-advertise__console"
          crest="club"
          eyebrow="Who Is Advertising"
          title="Your Business"
          pill={advertiser ? 'Open' : 'New'}
          pillInk={advertiser ? 'green' : 'blue'}
          foot="foot"
        >
          {advertiser?.status === 'suspended' ? (
            <p className="club-advertise__copy sc-ink--red" role="alert">
              Your Advertising Account Is Paused. Contact Smarter.Poker To Resume.
            </p>
          ) : null}
          <label className="club-advertise__field" htmlFor="adv-name">
            <span className="club-advertise__label sc-ink--blue">Business Name</span>
            <input
              id="adv-name"
              className="club-advertise__input"
              type="text"
              maxLength={80}
              value={advName}
              onChange={(e) => setAdvName(e.target.value)}
              placeholder="Acme Poker Supplies"
              disabled={advBusy}
            />
            <small className="club-advertise__hint">
              Shown On The Popup As Sponsored By, So Players Know Who Is Speaking.
            </small>
          </label>
          <label className="club-advertise__field" htmlFor="adv-email">
            <span className="club-advertise__label sc-ink--blue">Contact Email (Optional)</span>
            <input
              id="adv-email"
              className="club-advertise__input"
              type="email"
              maxLength={200}
              value={advEmail}
              onChange={(e) => setAdvEmail(e.target.value)}
              placeholder="ads@acme.example"
              disabled={advBusy}
            />
            <small className="club-advertise__hint">
              Where Smarter.Poker Sends The Invoice And Any Questions.
            </small>
          </label>
          <div className="club-advertise__row">
            <span className="club-advertise__label sc-ink--blue">
              {advertiser ? 'Advertising As' : 'Not Set Up Yet'}
            </span>
            <span className="club-advertise__value sc-ink--silver">{advertiser?.name ?? ''}</span>
          </div>
          <div className="club-advertise__words">
            <button
              type="button"
              className="club-advertise__word sc-ink--white"
              onClick={() => void saveAdvertiser()}
              disabled={!advertiserFormOk}
            >
              {advBusy ? 'Saving' : advertiser ? 'Save' : 'Start Advertising'}
            </button>
          </div>
        </SpadeConsole>
      ) : null}

      {/* ── Rate card ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="spade"
        eyebrow="The Rate Card"
        title="Where It Runs"
        /* The chosen surface's price per day, which is the number this section
           exists to answer. Never its name: the pill slot is 197px on a
           1000px master and "Announcement Card" is not a pill word. */
        pill={
          rate
            ? sponsorMode
              ? formatDollars(rate.sponsorCentsPerDay)
              : fmt(rate.diamondsPerDay)
            : 'Pick'
        }
        pillInk={rate ? 'gold' : 'blue'}
        foot="foot"
      >
        <div className="club-advertise__surfaces" role="group" aria-label="Where It Runs">
          {bookableRates.map((r) => (
            <button
              key={r.slot}
              type="button"
              className={`club-advertise__surface${r.slot === slot ? ' is-on' : ''}`}
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
              <span className="club-advertise__surface-main">
                <span className="club-advertise__surface-label">{r.label}</span>
                <span className="club-advertise__surface-size">
                  {`${r.creativeWidth} By ${r.creativeHeight}`}
                </span>
              </span>
              {sponsorMode ? (
                <span className="club-advertise__surface-price">
                  {formatDollars(r.sponsorCentsPerDay)} Per Day
                </span>
              ) : (
                <span className="club-advertise__surface-price">
                  {fmt(r.diamondsPerDay)} Per Day
                </span>
              )}
            </button>
          ))}
        </div>
        {rate ? <p className="club-advertise__copy">{rate.blurb}</p> : null}
      </SpadeConsole>

      {/* ── The creative ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="flat"
        eyebrow="The Creative"
        title="Your Picture"
        pill={file ? 'Ready' : 'Empty'}
        pillInk={file ? 'green' : 'muted'}
        foot="foot"
      >
        {rate ? (
          <p className="club-advertise__copy">
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
          <span className="club-advertise__word sc-ink--white">
            {file ? 'Choose A Different Picture' : 'Choose A Picture'}
          </span>
          {file ? <span className="club-advertise__file-name">{file.name}</span> : null}
        </label>
        {fileError ? (
          <p className="club-advertise__copy sc-ink--red" role="alert">
            {fileError}
          </p>
        ) : null}
      </SpadeConsole>

      {/* ── The poster: what a tap opens, full screen ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="flat"
        eyebrow="Full Screen"
        title="Your Poster"
        pill={poster ? 'Ready' : 'Empty'}
        pillInk={poster ? 'green' : 'muted'}
        foot="foot"
      >
        <p className="club-advertise__copy">
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
          <span className="club-advertise__word sc-ink--white">
            {poster ? 'Choose A Different Poster' : 'Choose A Poster'}
          </span>
          {poster ? <span className="club-advertise__file-name">{poster.name}</span> : null}
        </label>
        {posterError ? (
          <p className="club-advertise__copy sc-ink--red" role="alert">
            {posterError}
          </p>
        ) : null}
      </SpadeConsole>

      {/* ── The flight ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="spade"
        eyebrow="The Flight"
        title="The Details"
        pill={sponsorMode ? formatDollars(quoteCents) : fmt(cost)}
        pillInk={canAfford ? 'gold' : 'red'}
        foot="plates"
        plates={{
          secondary: {
            label: 'Not Yet',
            ink: 'silver',
            onClick: () => navigate(-1),
            disabled: busy,
          },
          primary: {
            label: busy ? 'Submitting' : sponsorMode ? 'Book It' : 'Pay And Submit',
            ink: canSubmit ? 'white' : 'muted',
            onClick: () => void submit(),
            disabled: !canSubmit,
          },
        }}
      >
        <label className="club-advertise__field" htmlFor="adv-headline">
          <span className="club-advertise__label sc-ink--blue">Headline</span>
          <input
            id="adv-headline"
            className="club-advertise__input"
            type="text"
            maxLength={120}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder={
              sponsorMode ? 'Free Shipping On Every Chip Set' : 'Sunday Deepstack, 10K Guaranteed'
            }
            disabled={busy}
          />
          <small className="club-advertise__hint">
            Read Aloud By Screen Readers, Printed Under The Poster, And Shown In Your Reports. Not
            Drawn On The Picture.
          </small>
        </label>
        {sponsorMode ? (
          <>
            <label className="club-advertise__field" htmlFor="adv-url">
              <span className="club-advertise__label sc-ink--blue">
                The Button Sends Players To
              </span>
              <input
                id="adv-url"
                className="club-advertise__input"
                type="url"
                maxLength={500}
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder="https://acme.example/poker"
                disabled={busy}
                inputMode="url"
              />
              <small className="club-advertise__hint">
                A Full HTTPS Address On Your Own Site. It Opens In A New Tab And Never Leaves A
                Player Signed Out.
              </small>
            </label>
            <label className="club-advertise__field" htmlFor="adv-countries">
              <span className="club-advertise__label sc-ink--blue">Countries (Optional)</span>
              <input
                id="adv-countries"
                className="club-advertise__input"
                type="text"
                maxLength={200}
                value={countriesText}
                onChange={(e) => setCountriesText(e.target.value)}
                placeholder="Leave Empty For Everywhere, Or US, CA, GB"
                disabled={busy}
                autoCapitalize="characters"
              />
              <small className="club-advertise__hint">
                {countriesOk
                  ? `Shown ${countriesLabel(parseCountries(countriesText))}. A Player Whose Location Is Unknown Never Sees A Country-Limited Advert.`
                  : 'Two-Letter Country Codes Only, Separated By Commas: US, CA, GB.'}
              </small>
            </label>
          </>
        ) : (
          <label className="club-advertise__field" htmlFor="adv-destination">
            <span className="club-advertise__label sc-ink--blue">Tapping It Opens</span>
            <select
              id="adv-destination"
              className="club-advertise__input"
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
        <label className="club-advertise__field" htmlFor="adv-days">
          <span className="club-advertise__label sc-ink--blue">Days</span>
          <input
            id="adv-days"
            className="club-advertise__input"
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
          <small className="club-advertise__hint">Starts As Soon As The House Approves It.</small>
        </label>
        {sponsorMode ? null : (
          <label className="club-advertise__field" htmlFor="adv-scope">
            <span className="club-advertise__label sc-ink--blue">Who Sees It</span>
            <select
              id="adv-scope"
              className="club-advertise__input"
              value={scope}
              onChange={(e) => setScope(e.target.value === 'own_club' ? 'own_club' : 'platform')}
              disabled={busy}
            >
              <option value="platform">Every Player On Smarter.Poker</option>
              <option value="own_club">Only Players Inside This Club</option>
            </select>
          </label>
        )}

        <div className="club-advertise__row">
          <span className="club-advertise__label sc-ink--blue">Total</span>
          <span className="club-advertise__value sc-ink--silver">
            {sponsorMode ? formatDollars(quoteCents) : fmt(cost)}
          </span>
        </div>
        <p className="club-advertise__hint">
          {sponsorMode ? (
            <>
              {rate ? `${formatDollars(rate.sponsorCentsPerDay)} x ${days} Day(s)` : ''}
              {' · '}Invoiced By Smarter.Poker Once Approved. Nothing Is Charged Here.
            </>
          ) : (
            <>{rate ? `${fmt(rate.diamondsPerDay)} x ${days} Day(s)` : ''}</>
          )}
        </p>
        {!canAfford ? (
          <p className="club-advertise__copy sc-ink--red" role="alert">
            Not Enough Diamonds For This Flight.
          </p>
        ) : null}
        {sponsorMode && !advertiser ? (
          <p className="club-advertise__hint">Save Your Business Details Above First.</p>
        ) : null}
      </SpadeConsole>

      {/* ── What this advertiser has bought ── */}
      <SpadeConsole
        className="club-advertise__console"
        crest="club"
        eyebrow="Bought And Running"
        title="Your Adverts"
        pill={String(campaigns.length)}
        pillInk="blue"
        foot="foot"
      >
        {campaigns.length === 0 ? (
          <p className="club-advertise__copy">
            Nothing Yet. The First One Appears Here The Moment You Submit It.
          </p>
        ) : (
          <ul className="club-advertise__list">
            {campaigns.map((c) => (
              <li key={c.id} className="club-advertise__item">
                <div className="club-advertise__item-top">
                  <span className="club-advertise__item-headline sc-ink--silver">
                    {titleCase(c.headline)}
                  </span>
                  <span
                    className={`club-advertise__status ${
                      c.displayStatus === 'live'
                        ? 'sc-ink--green'
                        : c.displayStatus === 'rejected' || c.displayStatus === 'cancelled'
                          ? 'sc-ink--red'
                          : 'sc-ink--blue'
                    }`}
                  >
                    {STATUS_LABEL[c.displayStatus] ?? titleCase(c.displayStatus)}
                  </span>
                </div>
                <div
                  className="club-advertise__item-picture"
                  style={{ aspectRatio: AD_SURFACE_RATIO[c.slot] }}
                >
                  <img src={c.imageUrl} alt={c.headline} loading="lazy" />
                </div>
                <div className="club-advertise__item-meta">
                  {titleCase(rates.find((r) => r.slot === c.slot)?.label ?? c.slot)} {'·'} {c.days}{' '}
                  Day(s) {'·'} {formatDate(c.startsAt)} To {formatDate(c.endsAt)}
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
                      {'·'} {fmt(c.diamondsCharged)} Diamonds
                      {c.diamondsRefunded > 0 ? ` (${fmt(c.diamondsRefunded)} Refunded)` : ''}
                    </>
                  )}
                </div>
                {c.reviewNote ? (
                  <div className="club-advertise__item-note">
                    Note From The House: {titleCase(c.reviewNote)}
                  </div>
                ) : null}
                {c.status === 'approved' ? (
                  <div className="club-advertise__item-stats">
                    <span>
                      <strong>{fmt(c.viewers)}</strong> People
                    </span>
                    <span>
                      <strong>{fmt(c.impressions)}</strong> Shown
                    </span>
                    <span>
                      <strong>{fmt(c.viewable)}</strong> Seen
                    </span>
                    <span>
                      <strong>{fmt(c.clicks)}</strong> Taps
                    </span>
                  </div>
                ) : null}
                <div className="club-advertise__words">
                  {c.status === 'approved' ? (
                    <button
                      type="button"
                      className="club-advertise__word sc-ink--blue"
                      onClick={() => void toggleReport(c)}
                      aria-expanded={reportFor === c.id}
                    >
                      {reportFor === c.id ? 'Hide Day By Day' : 'Day By Day'}
                    </button>
                  ) : null}
                  {c.status === 'submitted' ? (
                    <button
                      type="button"
                      className="club-advertise__word sc-ink--red"
                      onClick={() => void cancel(c)}
                    >
                      {sponsorMode ? 'Withdraw' : 'Withdraw And Refund'}
                    </button>
                  ) : null}
                </div>
                {reportFor === c.id ? (
                  reportFailure ? (
                    <p className="club-advertise__copy sc-ink--red" role="alert">
                      {reportFailure}
                    </p>
                  ) : report == null ? (
                    <p className="club-advertise__hint">Reading</p>
                  ) : report.length === 0 ? (
                    <p className="club-advertise__hint">No Days To Show Yet.</p>
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
              </li>
            ))}
          </ul>
        )}
      </SpadeConsole>
    </div>
  );
}
