/**
 * CAMPAIGN QUEUE - the house reviews what clubs have bought.
 *
 * Mounted on the House Ads admin page. Every decision goes through
 * `fn_ad_campaign_review`, which checks the caller is platform staff, turns an
 * approval into inventory (catalog row + placement) and refunds a rejection
 * through the diamond journal. This component shows the picture in the
 * surface's true shape, asks for a note on rejection, and repeats the answer.
 */

import { useCallback, useEffect, useState } from 'react';
import { AdCampaignService } from '../../services/AdCampaignService';
import type { AdCampaign } from '../../services/AdCampaignService';
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

export default function CampaignQueue() {
  const [campaigns, setCampaigns] = useState<AdCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setCampaigns(await AdCampaignService.list(null));
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
          ? `${c.clubName} Paid ${c.diamondsCharged.toLocaleString()} Diamonds. It Goes Live On The ${SLOT_LABEL[c.slot] ?? c.slot} For ${c.days} Day(s).`
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

  const pending = (campaigns ?? []).filter((c) => c.status === 'submitted');
  const rest = (campaigns ?? []).filter((c) => c.status !== 'submitted');

  return (
    <div className="admin-card campaign-queue">
      <h2 className="admin-card-title">Club Adverts</h2>
      <p className="admin-text-secondary campaign-queue__intro">
        Clubs Pay Diamonds For A Flight. Nothing Runs Until Someone Here Approves It. A Rejection
        Refunds In Full.
      </p>

      {error && <div className="admin-error-banner">{error}</div>}

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
                  {c.days} Day(s) {'·'} {c.diamondsCharged.toLocaleString()} Diamonds {'·'} Opens{' '}
                  <code>{c.targetUrl}</code>
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
                    <td>{SLOT_LABEL[c.slot] ?? c.slot}</td>
                    <td>{STATUS_LABEL[c.displayStatus] ?? c.displayStatus}</td>
                    <td>
                      {new Date(c.startsAt).toLocaleDateString()} To{' '}
                      {new Date(c.endsAt).toLocaleDateString()}
                    </td>
                    <td>
                      {c.diamondsCharged.toLocaleString()}
                      {c.diamondsRefunded > 0
                        ? ` (${c.diamondsRefunded.toLocaleString()} Back)`
                        : ''}
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
    </div>
  );
}
