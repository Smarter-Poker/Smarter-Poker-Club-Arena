/**
 * CAMPAIGN QUEUE - the house reviews what advertisers have booked, and opens a
 * flight for an outside sponsor.
 *
 * Mounted on the House Ads admin page. Every decision goes through
 * `fn_ad_campaign_review`, which checks the caller is platform staff, turns an
 * approval into inventory (catalog row + placement) and refunds a rejection
 * through the diamond journal. This component shows the picture in the
 * surface's true shape, asks for a note on rejection, and repeats the answer.
 *
 * A SPONSOR IS OPENED HERE, NOT BOUGHT. A club buys its own flight with
 * diamonds; an outside advertiser is sold to by a person and invoiced off
 * platform, so there is no self-serve door for one and no money moves through
 * this form. What it does collect is the one thing a sponsor has that nobody
 * else does: an address on their own site. That address is stored on the
 * campaign and never served to a browser - approval mints an opaque code and
 * the advert points at `/c/<code>`, so every same-origin check on this
 * platform still sees the rooted path it has always seen.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AdCampaignService,
  billingLabel,
  countriesLabel,
  formatDollars,
  parseCountries,
} from '../../services/AdCampaignService';
import type {
  AdCampaign,
  AdRateCard,
  SponsorAdvertiserRow,
} from '../../services/AdCampaignService';
import type { AdSlot } from '../../services/AdService';
import { AD_SURFACE_RATIO } from './HouseAdRotator';
import { confirmDialog } from '../common/confirmDialog';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import './CampaignQueue.css';

const SLOT_LABEL: Record<string, string> = {
  lobby_strip: 'Lobby Strip',
  session_summary: 'Session Summary',
  empty_state: 'Empty Lobby',
  hub_promotions: 'Hub Promotions',
  table_between_hands: 'Between Hands',
};

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Awaiting Review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  live: 'Live',
  finished: 'Finished',
  rejected: 'Not Approved',
  cancelled: 'Cancelled',
};

const EMPTY_SPONSOR = {
  advertiserName: '',
  headline: '',
  slot: 'lobby_strip' as AdSlot,
  imageUrl: '',
  posterUrl: '',
  externalUrl: '',
  days: 7,
  contactEmail: '',
  goalImpressions: '',
  countries: '',
};

export default function CampaignQueue() {
  const [campaigns, setCampaigns] = useState<AdCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [rates, setRates] = useState<AdRateCard[]>([]);
  const [sponsorOpen, setSponsorOpen] = useState(false);
  const [sponsor, setSponsor] = useState(EMPTY_SPONSOR);
  const [sponsorBusy, setSponsorBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sponsors, setSponsors] = useState<SponsorAdvertiserRow[]>([]);
  const [handoffEmail, setHandoffEmail] = useState<Record<string, string>>({});
  const [handoffBusy, setHandoffBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCampaigns(await AdCampaignService.list(null));
      /* The sponsor roster is a second read with the same shape as the rate
         card: losing it loses the hand-off panel, never the queue. */
      try {
        setSponsors(await AdCampaignService.sponsorAdvertisers());
      } catch {
        setSponsors([]);
      }
      /* The rate card names each surface and the exact creative size it takes.
         A failure here loses the labels, not the queue, so it does not clear
         the campaigns or raise. */
      try {
        setRates(await AdCampaignService.rateCard());
      } catch {
        setRates([]);
      }
      setError(null);
    } catch (e) {
      /* null, never an empty list: "nothing to review" and "could not read"
         are different facts and the second must not look like the first. */
      setCampaigns(null);
      setError(safeErrorMessage(e, 'Campaigns Could Not Be Read'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (c: AdCampaign, decision: 'approve' | 'reject') => {
    const note = (notes[c.id] ?? '').trim();
    if (decision === 'reject' && note.length === 0) {
      setError('Say Why In The Note Before Rejecting. The Club Reads It.');
      return;
    }
    const ok = await confirmDialog({
      title: decision === 'approve' ? 'Approve This Advert?' : 'Reject And Refund?',
      message:
        decision === 'approve'
          ? c.clubId == null
            ? `${c.clubName} Was Quoted ${formatDollars(c.quotedCents ?? 0)}. Approving Makes It Live On The ${SLOT_LABEL[c.slot] ?? c.slot} For ${c.days} Day(s) And Means Somebody Raises That Invoice.`
            : `${c.clubName} Paid ${c.diamondsCharged.toLocaleString()} Diamonds. It Goes Live On The ${SLOT_LABEL[c.slot] ?? c.slot} For ${c.days} Day(s).`
          : c.clubId == null
            ? `${c.clubName} Is Told It Was Not Approved. Nothing Was Charged.`
            : `${c.diamondsCharged.toLocaleString()} Diamonds Go Back To ${c.clubName}.`,
      confirmText: decision === 'approve' ? 'Approve' : 'Reject And Refund',
      cancelText: 'Back',
      variant: decision === 'reject' ? 'danger' : 'default',
    });
    if (!ok) return;
    setBusyId(c.id);
    setError(null);
    const res = await AdCampaignService.review(c.id, decision, note || undefined);
    setBusyId(null);
    if (!res.ok) {
      setError(
        `Could Not ${decision === 'approve' ? 'Approve' : 'Reject'}: ${res.reason ?? 'Unknown'}`
      );
      return;
    }
    await load();
  };

  /* An offline fact, recorded: somebody sent the invoice, somebody saw it
     paid. No chips and no diamonds move. 'none' is the undo for a slip. */
  const bill = async (c: AdCampaign, mark: 'invoiced' | 'paid' | 'none') => {
    const label: Record<typeof mark, string> = {
      invoiced: `Record The ${formatDollars(c.quotedCents ?? 0)} Invoice To ${c.clubName} As Sent?`,
      paid: `Record ${formatDollars(c.quotedCents ?? 0)} From ${c.clubName} As Paid?`,
      none: `Clear The Billing Marks On ${c.clubName}'s Flight? The Quote Stays.`,
    };
    const ok = await confirmDialog({
      title: mark === 'none' ? 'Clear Billing Marks?' : 'Record It?',
      message: label[mark],
      confirmText: mark === 'none' ? 'Clear' : 'Record',
      cancelText: 'Back',
      variant: mark === 'none' ? 'danger' : 'default',
    });
    if (!ok) return;
    setBusyId(c.id);
    setError(null);
    const res = await AdCampaignService.bill(c.id, mark);
    setBusyId(null);
    if (!res.ok) {
      const why: Record<string, string> = {
        not_platform_admin: 'Only Smarter.Poker Staff Can Record Billing',
        not_a_sponsor_flight: 'Only A Sponsor Flight Is Invoiced. A Club Paid In Diamonds.',
        not_approved: 'An Invoice Is For An Approved Flight. Approve It First.',
      };
      setError(why[res.reason ?? ''] ?? `Could Not Record It: ${res.reason ?? 'Unknown'}`);
      return;
    }
    await load();
  };

  /* A sponsor opened over the phone becomes one that logs in. */
  const handoff = async (a: SponsorAdvertiserRow) => {
    const email = (handoffEmail[a.id] ?? a.contactEmail ?? '').trim();
    if (!email) {
      setError('Type The E-Mail Of The Account That Will Own This Sponsor.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Hand This Sponsor To An Account?',
      message: `${a.name} Becomes Owned By ${email}. That Account Sees Every Flight Booked For It, Its Quotes And Its Invoices, And Can Book Its Own. This Is Not Undone From Here.`,
      confirmText: 'Hand It Off',
      cancelText: 'Back',
    });
    if (!ok) return;
    setHandoffBusy(a.id);
    setError(null);
    setNotice(null);
    const res = await AdCampaignService.advertiserHandoff(a.id, email);
    setHandoffBusy(null);
    if (!res.ok) {
      const why: Record<string, string> = {
        not_platform_admin: 'Only Smarter.Poker Staff Can Hand Off A Sponsor',
        bad_email: 'That Is Not An E-Mail Address',
        not_a_sponsor: 'That Advertiser Is Not A Sponsor',
        already_handed_off: 'That Sponsor Already Has An Account',
        no_account_with_that_email: 'No Smarter.Poker Account Has That E-Mail. They Sign Up First.',
        account_already_has_a_sponsor:
          'That Account Already Owns A Sponsor. One Sponsor Per Account.',
      };
      setError(why[res.reason ?? ''] ?? `Could Not Hand It Off: ${res.reason ?? 'Unknown'}`);
      return;
    }
    setNotice(`${a.name} Is Now Owned By ${email}.`);
    await load();
  };

  const submitSponsor = async () => {
    const rate = rates.find((r) => r.slot === sponsor.slot);
    const ok = await confirmDialog({
      title: 'Open This Sponsor Flight?',
      message: `${sponsor.advertiserName || 'This Advertiser'} Runs On The ${
        rate?.label ?? sponsor.slot
      } For ${sponsor.days} Day(s), Then Goes Into The Queue Below For Approval. No Diamonds Are Charged: A Sponsor Is Invoiced Off Platform.`,
      confirmText: 'Open It',
      cancelText: 'Back',
    });
    if (!ok) return;
    setSponsorBusy(true);
    setError(null);
    setNotice(null);
    const res = await AdCampaignService.createSponsor({
      advertiserName: sponsor.advertiserName.trim(),
      headline: sponsor.headline.trim(),
      slot: sponsor.slot,
      imageUrl: sponsor.imageUrl.trim(),
      posterUrl: sponsor.posterUrl.trim() || null,
      externalUrl: sponsor.externalUrl.trim(),
      startsAt: new Date(),
      days: sponsor.days,
      contactEmail: sponsor.contactEmail.trim() || null,
      goalImpressions: sponsor.goalImpressions ? Number(sponsor.goalImpressions) : null,
      countries: parseCountries(sponsor.countries) ?? null,
    });
    setSponsorBusy(false);
    if (!res.ok) {
      const why: Record<string, string> = {
        not_platform_admin: 'Only Smarter.Poker Staff Can Open A Sponsor Flight',
        bad_advertiser_name: 'Give The Advertiser A Name',
        bad_headline: 'Give The Advert A Short Headline',
        unknown_slot: 'That Surface Does Not Exist',
        bad_days: 'Choose Between 1 And 365 Days',
        creative_not_same_origin: 'The Creative Must Be A Path On This Site, Uploaded First',
        poster_not_same_origin: 'The Poster Must Be A Path On This Site, Uploaded First',
        destination_must_be_https: 'The Destination Must Be A Full https Address',
        bad_pacing: 'Pacing Must Be Even Or Asap',
        bad_countries: 'Countries Are Two-Letter Codes Separated By Commas: US, CA, GB',
      };
      setError(why[res.reason] ?? `Could Not Open It: ${res.reason}`);
      return;
    }
    setNotice('Opened. It Is Waiting For Approval In The Queue Below.');
    setSponsor(EMPTY_SPONSOR);
    setSponsorOpen(false);
    await load();
  };

  const pending = (campaigns ?? []).filter((c) => c.status === 'submitted');
  const rest = (campaigns ?? []).filter((c) => c.status !== 'submitted');
  const sponsorReady =
    sponsor.advertiserName.trim().length > 0 &&
    parseCountries(sponsor.countries) !== undefined &&
    sponsor.headline.trim().length > 0 &&
    sponsor.imageUrl.trim().startsWith('/') &&
    (sponsor.posterUrl.trim() === '' || sponsor.posterUrl.trim().startsWith('/')) &&
    /^https:\/\/[a-zA-Z0-9]/.test(sponsor.externalUrl.trim()) &&
    sponsor.days >= 1 &&
    !sponsorBusy;

  return (
    <div className="admin-card campaign-queue">
      <h2 className="admin-card-title">Club Adverts</h2>
      <p className="admin-text-secondary campaign-queue__intro">
        Clubs Pay Diamonds For A Flight. Nothing Runs Until Someone Here Approves It. A Rejection
        Refunds In Full.
      </p>

      {error && <div className="admin-error-banner">{error}</div>}
      {notice && <div className="admin-success-banner">{notice}</div>}

      {/* ── Open a flight for an outside advertiser ── */}
      <div className="campaign-queue__sponsor">
        <button
          type="button"
          className="admin-btn admin-btn-ghost admin-btn-sm"
          onClick={() => setSponsorOpen((v) => !v)}
          aria-expanded={sponsorOpen}
        >
          {sponsorOpen ? 'Close' : 'Open A Sponsor Flight'}
        </button>

        {sponsorOpen ? (
          <div className="campaign-queue__sponsor-form">
            <p className="admin-text-secondary campaign-queue__intro">
              For An Outside Advertiser. No Diamonds Are Charged Here: A Sponsor Is Invoiced Off
              Platform. Their Address Is Stored On The Campaign And Never Handed To A Browser, So
              Every Same-Origin Check Still Holds; Approval Turns It Into A Tracked Link.
            </p>
            <div className="campaign-queue__grid">
              <label className="campaign-queue__field">
                <span className="admin-label">Advertiser</span>
                <input
                  className="admin-input"
                  maxLength={80}
                  value={sponsor.advertiserName}
                  onChange={(e) => setSponsor((s) => ({ ...s, advertiserName: e.target.value }))}
                  placeholder="Acme Poker Tools"
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Contact Email</span>
                <input
                  className="admin-input"
                  maxLength={120}
                  value={sponsor.contactEmail}
                  onChange={(e) => setSponsor((s) => ({ ...s, contactEmail: e.target.value }))}
                  placeholder="ads@acme.example"
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Headline</span>
                <input
                  className="admin-input"
                  maxLength={120}
                  value={sponsor.headline}
                  onChange={(e) => setSponsor((s) => ({ ...s, headline: e.target.value }))}
                  placeholder="Read Aloud By Screen Readers. Not Drawn On The Picture."
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Surface</span>
                <select
                  className="admin-input"
                  value={sponsor.slot}
                  onChange={(e) => setSponsor((s) => ({ ...s, slot: e.target.value as AdSlot }))}
                  disabled={sponsorBusy}
                >
                  {(rates.length > 0
                    ? rates
                    : [{ slot: 'lobby_strip' as AdSlot, label: 'Lobby Strip' } as AdRateCard]
                  ).map((r) => (
                    <option key={r.slot} value={r.slot}>
                      {r.label}
                      {r.creativeWidth ? ` (${r.creativeWidth} By ${r.creativeHeight})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Creative Path</span>
                <input
                  className="admin-input"
                  maxLength={300}
                  value={sponsor.imageUrl}
                  onChange={(e) => setSponsor((s) => ({ ...s, imageUrl: e.target.value }))}
                  placeholder="/ad-creatives/sponsor/acme/lobby-strip.webp"
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Poster Path (3 By 4, Optional)</span>
                <input
                  className="admin-input"
                  maxLength={300}
                  value={sponsor.posterUrl}
                  onChange={(e) => setSponsor((s) => ({ ...s, posterUrl: e.target.value }))}
                  placeholder="/ad-creatives/sponsor/acme/poster.webp"
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Their Address</span>
                <input
                  className="admin-input"
                  maxLength={500}
                  value={sponsor.externalUrl}
                  onChange={(e) => setSponsor((s) => ({ ...s, externalUrl: e.target.value }))}
                  placeholder="https://acme.example/landing"
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Days</span>
                <input
                  className="admin-input"
                  type="number"
                  min={1}
                  max={365}
                  value={sponsor.days}
                  onChange={(e) =>
                    setSponsor((s) => ({
                      ...s,
                      days: Math.max(1, Math.min(365, Number(e.target.value) || 1)),
                    }))
                  }
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Impression Goal</span>
                <input
                  className="admin-input"
                  type="number"
                  min={1}
                  value={sponsor.goalImpressions}
                  onChange={(e) => setSponsor((s) => ({ ...s, goalImpressions: e.target.value }))}
                  placeholder="Optional. Spreads Delivery Evenly Across The Flight."
                  disabled={sponsorBusy}
                />
              </label>
              <label className="campaign-queue__field">
                <span className="admin-label">Countries</span>
                <input
                  className="admin-input"
                  type="text"
                  maxLength={200}
                  value={sponsor.countries}
                  onChange={(e) => setSponsor((s) => ({ ...s, countries: e.target.value }))}
                  placeholder="Optional. US, CA, GB. Empty Means Everywhere."
                  disabled={sponsorBusy}
                />
              </label>
            </div>
            <div className="campaign-queue__actions">
              <button
                type="button"
                className="admin-btn admin-btn-primary admin-btn-sm"
                disabled={!sponsorReady}
                onClick={() => void submitSponsor()}
              >
                {sponsorBusy ? 'Opening' : 'Open It'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {campaigns === null && !error ? (
        <div className="admin-text-secondary">Reading</div>
      ) : campaigns === null ? null : pending.length === 0 ? (
        <div className="admin-text-secondary">Nothing Waiting For Review.</div>
      ) : (
        <ul className="campaign-queue__list">
          {pending.map((c) => (
            <li key={c.id} className="campaign-queue__item">
              <div
                className="campaign-queue__picture"
                style={{ aspectRatio: AD_SURFACE_RATIO[c.slot] }}
              >
                <img src={c.imageUrl} alt={c.headline} loading="lazy" />
              </div>
              <div className="campaign-queue__body">
                <div className="campaign-queue__top">
                  <strong>{c.clubName}</strong>
                  <span className="campaign-queue__chip">{SLOT_LABEL[c.slot] ?? c.slot}</span>
                  <span className="campaign-queue__chip">
                    {c.scope === 'own_club' ? 'Own Club Only' : 'Every Player'}
                  </span>
                </div>
                <div className="campaign-queue__headline">{c.headline}</div>
                <div className="campaign-queue__meta">
                  {c.days} Day(s) {'·'}{' '}
                  {c.clubId == null
                    ? `${formatDollars(c.quotedCents ?? 0)} To Invoice`
                    : `${c.diamondsCharged.toLocaleString()} Diamonds`}{' '}
                  {'·'} Opens <code>{c.targetUrl}</code>
                  {c.countries ? (
                    <>
                      {' '}
                      {'·'} {countriesLabel(c.countries)}
                    </>
                  ) : null}
                </div>
                <label className="campaign-queue__note">
                  <span className="admin-label">Note To The Club</span>
                  <input
                    className="admin-input"
                    type="text"
                    maxLength={240}
                    value={notes[c.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                    placeholder="Required For A Rejection"
                    disabled={busyId === c.id}
                  />
                </label>
                <div className="campaign-queue__actions">
                  <button
                    type="button"
                    className="admin-btn admin-btn-success admin-btn-sm"
                    disabled={busyId === c.id}
                    onClick={() => void decide(c, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn-danger admin-btn-sm"
                    disabled={busyId === c.id}
                    onClick={() => void decide(c, 'reject')}
                  >
                    Reject And Refund
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rest.length > 0 ? (
        <div className="campaign-queue__history">
          <button
            type="button"
            className="admin-btn admin-btn-ghost admin-btn-sm"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Hide' : 'Show'} {rest.length} Reviewed
          </button>
          {showAll ? (
            <table className="campaign-queue__table">
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Surface</th>
                  <th>State</th>
                  <th>Flight</th>
                  <th>Diamonds</th>
                  <th>Billing</th>
                  <th>People</th>
                  <th>Shown</th>
                  <th>Seen</th>
                  <th>Taps</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((c) => (
                  <tr key={c.id}>
                    <td>{c.clubName}</td>
                    <td>
                      {SLOT_LABEL[c.slot] ?? c.slot}
                      {c.countries ? ` (${countriesLabel(c.countries)})` : ''}
                    </td>
                    <td>{STATUS_LABEL[c.displayStatus] ?? c.displayStatus}</td>
                    <td>
                      {new Date(c.startsAt).toLocaleDateString()} To{' '}
                      {new Date(c.endsAt).toLocaleDateString()}
                    </td>
                    <td>
                      {c.clubId == null
                        ? `${formatDollars(c.quotedCents ?? 0)} Invoice`
                        : c.diamondsCharged.toLocaleString()}
                      {c.diamondsRefunded > 0
                        ? ` (${c.diamondsRefunded.toLocaleString()} Back)`
                        : ''}
                    </td>
                    <td>
                      {c.clubId == null && c.status === 'approved' ? (
                        <span className="campaign-queue__billing">
                          <span>{billingLabel(c)}</span>
                          {c.paidAt == null ? (
                            <button
                              type="button"
                              className="admin-btn admin-btn-success admin-btn-sm"
                              disabled={busyId === c.id}
                              onClick={() =>
                                void bill(c, c.invoicedAt == null ? 'invoiced' : 'paid')
                              }
                            >
                              {c.invoicedAt == null ? 'Invoice Sent' : 'Paid'}
                            </button>
                          ) : null}
                          {c.invoicedAt != null ? (
                            <button
                              type="button"
                              className="admin-btn admin-btn-ghost admin-btn-sm"
                              disabled={busyId === c.id}
                              onClick={() => void bill(c, 'none')}
                            >
                              Clear
                            </button>
                          ) : null}
                        </span>
                      ) : c.clubId == null ? (
                        billingLabel(c)
                      ) : (
                        'Diamonds'
                      )}
                    </td>
                    <td>{c.viewers.toLocaleString()}</td>
                    <td>{c.impressions.toLocaleString()}</td>
                    <td>{c.viewable.toLocaleString()}</td>
                    <td>{c.clicks.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {sponsors.length > 0 ? (
        <div className="campaign-queue__roster">
          <h3 className="campaign-queue__roster-title">Sponsors</h3>
          <p className="campaign-queue__roster-hint">
            A Sponsor Opened Over The Phone Has No Login. Hand It To The Account That Will Own It
            And That Person Sees Every Flight, Quote And Invoice On Their Own Advertise Page.
          </p>
          <table className="campaign-queue__table">
            <thead>
              <tr>
                <th>Sponsor</th>
                <th>Contact</th>
                <th>Owner</th>
                <th>Flights</th>
                <th>Unpaid</th>
                <th>Hand Off</th>
              </tr>
            </thead>
            <tbody>
              {sponsors.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.contactEmail ?? ''}</td>
                  <td>{a.selfServe ? (a.ownerEmail ?? 'Logs In') : 'Phone'}</td>
                  <td>{a.flights.toLocaleString()}</td>
                  <td>{a.unpaidCents > 0 ? formatDollars(a.unpaidCents) : ''}</td>
                  <td>
                    {a.selfServe ? (
                      ''
                    ) : (
                      <span className="campaign-queue__handoff">
                        <input
                          className="admin-input"
                          type="email"
                          value={handoffEmail[a.id] ?? a.contactEmail ?? ''}
                          onChange={(e) =>
                            setHandoffEmail((m) => ({ ...m, [a.id]: e.target.value }))
                          }
                          placeholder="Account E-Mail"
                          disabled={handoffBusy === a.id}
                        />
                        <button
                          type="button"
                          className="admin-btn admin-btn-sm"
                          disabled={handoffBusy === a.id}
                          onClick={() => void handoff(a)}
                        >
                          Hand Off
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
