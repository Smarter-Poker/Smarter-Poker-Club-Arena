/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CLUB'S MINI JACKPOT SWITCH
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-11: "mini bad beat also needs to be a 'toggleable' on / off
 * feature inside clubs (that have no union affiliation) but should be 'added by
 * default' when a new club is started."
 *
 * The default lives in the column (`bbj_pools.mini_enabled NOT NULL DEFAULT
 * true`), not here, so a club has the mini from its first hand whether or not
 * anybody ever opens this page.
 *
 * WHO SEES A CONTROL, and why this is not decided in the browser. The database
 * answers both halves - `can_toggle` on `fn_bbj_mini_for_club` is true only for
 * a club whose pool is its own, which is exactly the club
 * `fn_bbj_set_club_mini_enabled` will accept - so the switch cannot be drawn for
 * a club the write would refuse. A club inside a union is TOLD why rather than
 * shown a dead control or nothing at all: its mini pays out of the union's
 * shared reserve, so one member club flipping it would turn the mini off for
 * every other club in that union.
 *
 * A REFUSAL IS REPORTED, NOT SWALLOWED. The button reflects what the database
 * says after the write, never what was clicked: an optimistic flip that the
 * server then refused would leave an operator believing they had switched off a
 * jackpot that kept paying.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  watchBbjMini,
  setBbjMiniEnabled,
  setBbjMiniFloor,
  type BbjMiniSnapshot,
} from '../../lib/bbjMiniFeed';
import { useToast } from '../common/Toast';

interface Props {
  clubId: string;
  /** The page's own view of the viewer. The database is still the authority. */
  canEdit: boolean;
}

const chips = (n: number) => Math.round(n).toLocaleString('en-US');

/** Why the database refused, in words an operator can act on. */
function refusalText(reason: string): string {
  switch (reason) {
    case 'union_club_follows_the_union':
      return "This Club Belongs To A Union, So The Mini Jackpot Is The Union's To Set.";
    case 'not_a_club_admin':
      return 'Only A Club Owner, Co-Owner, Admin Or Manager Can Change This.';
    case 'club_not_found':
      return 'That Club No Longer Exists.';
    case 'not_signed_in':
      return 'You Are Signed Out. Sign In Again To Change This.';
    case 'club_and_state_required':
    case 'club_and_floor_required':
      return 'That Request Was Incomplete. Nothing Changed.';
    case 'floor_cannot_be_negative':
      return 'A Reserve Floor Cannot Be Negative.';
    case 'floor_below_one_payout':
      return 'The Floor Must Cover At Least One Mini Payout At The Largest Stakes.';
    case 'pool_not_found':
      return 'This Club Has No Jackpot Pool Yet.';
    default:
      return 'The Mini Jackpot Setting Could Not Be Saved. Nothing Changed.';
  }
}

export default function BBJMiniPanel({ clubId, canEdit }: Props) {
  const toast = useToast();
  const [mini, setMini] = useState<BbjMiniSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  /* The floor the operator is typing. Null means "showing the stored value" -
     the input never fights the feed while it is not being edited. */
  const [floorDraft, setFloorDraft] = useState<string | null>(null);

  useEffect(() => {
    /* Clear FIRST. `watchBbjMini` replays immediately only when that club is
       already cached, so without this the panel kept rendering the previous
       club's backup balance, reserve floor and 30-day hit count under the new
       club's heading until the RPC answered - the wrong club's money, shown as
       if it were this one's. "Loading" is the honest state. */
    setMini(null);
    if (!clubId) return;
    return watchBbjMini(clubId, setMini);
  }, [clubId]);

  const onToggle = useCallback(async () => {
    if (!mini || busy) return;
    const next = !mini.clubSwitch;
    setBusy(true);
    try {
      const res = await setBbjMiniEnabled(clubId, next);
      if (!res.ok) {
        toast.error(refusalText(res.reason));
        return;
      }
      toast.success(res.enabled ? 'Mini Jackpot Is On' : 'Mini Jackpot Is Off');
    } finally {
      setBusy(false);
    }
  }, [mini, busy, clubId, toast]);

  const onSaveFloor = useCallback(async () => {
    if (floorDraft === null || busy) return;
    const next = Number(floorDraft);
    if (!Number.isFinite(next)) {
      toast.error('That Is Not A Number.');
      return;
    }
    setBusy(true);
    try {
      const res = await setBbjMiniFloor(clubId, next);
      if (!res.ok) {
        toast.error(refusalText(res.reason));
        return;
      }
      setFloorDraft(null);
      toast.success('Reserve Floor Saved');
    } finally {
      setBusy(false);
    }
  }, [floorDraft, busy, clubId, toast]);

  if (!clubId) return null;

  if (!mini) {
    return (
      <section className="settings-section">
        <h3>Mini Bad Beat Jackpot</h3>
        <small className="form-hint">Loading</small>
      </section>
    );
  }

  const payable = mini.tiers.filter((t) => t.enabled && t.payable).map((t) => t.amount);
  const range =
    payable.length > 0
      ? payable.length === 1 || Math.min(...payable) === Math.max(...payable)
        ? chips(payable[0])
        : `${chips(Math.min(...payable))} - ${chips(Math.max(...payable))}`
      : null;

  /* The database decides. `canEdit` only lets the page hide a control from a
     viewer it already knows is not staff; it can never ADD one. */
  const showSwitch = mini.canToggle && canEdit;

  return (
    <section className="settings-section">
      <h3>Mini Bad Beat Jackpot</h3>

      <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
        A Second, Smaller Jackpot For The Bad Beats The Main Rule Turns Away: Aces Full Or Better
        Losing To Quads Or Better In Hold’em, Any Quads Losing To Bigger Quads Or Better In Omaha.
        It Pays A Flat Amount Set By The Stakes, Out Of The Jackpot’s Backup Pool. No Extra Fee Is
        Taken For It.
      </small>

      {mini.isUnionPool && (
        <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
          This Club Belongs To A Union, So Its Mini Jackpot Pays From The Union’s Shared Reserve,
          Which Every Member Club Draws On. It Is On For The Whole Union And Is Not Switched Per
          Club. Leaving The Union Gives This Club Its Own Pool And Its Own Switch.
        </small>
      )}

      <div className="toggle-row">
        <div>
          <label>Status</label>
          <small className="form-hint">
            {mini.clubSwitch
              ? range
                ? `Paying ${range} By Stakes`
                : 'On, But Paused While The Backup Pool Is At Its Floor'
              : 'Off For This Club'}
          </small>
        </div>
        {showSwitch ? (
          <button
            type="button"
            className={`toggle-btn ${mini.clubSwitch ? 'on' : ''}`}
            onClick={onToggle}
            disabled={busy}
            aria-pressed={mini.clubSwitch}
            aria-label={mini.clubSwitch ? 'Turn The Mini Jackpot Off' : 'Turn The Mini Jackpot On'}
          >
            {busy ? '...' : mini.clubSwitch ? 'ON' : 'OFF'}
          </button>
        ) : (
          <span
            className={`toggle-btn ${mini.clubSwitch ? 'on' : ''}`}
            style={{ pointerEvents: 'none' }}
          >
            {mini.clubSwitch ? 'ON' : 'OFF'}
          </span>
        )}
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>Backup Pool</label>
          <strong>{chips(mini.backupBalance)} Chips</strong>
        </div>
        <div className="form-group">
          <label>Reserve Floor</label>
          <strong>{chips(mini.reserveFloor)} Chips</strong>
        </div>
      </div>

      {/* THE RUNWAY (phase 3). The mini's price is global; its funding is this
          pool's own rake. Nothing used to compare the two, so a pool paying out
          faster than it fills drifted to its floor and stopped - and the only
          symptom was every tier quietly turning unpayable. Both rates are
          measured over ONE window so they are comparable. */}
      <div className="form-row">
        <div className="form-group">
          <label>Reserve Filling</label>
          <strong>{chips(mini.inPerDay)} A Day</strong>
        </div>
        <div className="form-group">
          <label>Mini Paying Out</label>
          <strong>{chips(mini.outPerDay)} A Day</strong>
        </div>
        <div className="form-group">
          <label>Net</label>
          <strong style={{ color: mini.netPerDay < 0 ? '#d9534f' : undefined }}>
            {mini.netPerDay >= 0 ? '+' : ''}
            {chips(mini.netPerDay)} A Day
          </strong>
        </div>
      </div>

      <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
        {mini.daysToFloor === null
          ? `This Reserve Is Not Draining At The Current Rate, Measured Over ${mini.windowDays.toFixed(1)} Days.`
          : `At The Current Rate This Reserve Reaches Its Floor In About ${mini.daysToFloor.toFixed(1)} Days, After Which The Mini Pauses Until It Refills. Measured Over ${mini.windowDays.toFixed(1)} Days.`}
      </small>

      {showSwitch && (
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="bbj-mini-floor">Reserve Floor</label>
            <input
              id="bbj-mini-floor"
              type="number"
              min={mini.floorMinimum}
              step="100"
              value={floorDraft ?? String(Math.round(mini.reserveFloor))}
              onChange={(e) => setFloorDraft(e.target.value)}
              disabled={busy}
            />
            <small className="form-hint">
              The Backup Pool Never Drops Below This. Lowest Allowed Is {chips(mini.floorMinimum)} -
              One Payout At The Largest Stakes.
            </small>
          </div>
          <div className="form-group">
            <button
              type="button"
              className="btn-secondary"
              onClick={onSaveFloor}
              disabled={busy || floorDraft === null}
            >
              {busy ? '...' : 'Save Floor'}
            </button>
          </div>
        </div>
      )}

      <small className="form-hint" style={{ display: 'block' }}>
        The Mini Pauses On Its Own While The Backup Pool Is At Its Floor, And Resumes When It
        Refills. Last 30 Days: {mini.hits30d.toLocaleString('en-US')}{' '}
        {mini.hits30d === 1 ? 'Mini Jackpot' : 'Mini Jackpots'}, {chips(mini.paid30d)} Chips Paid.
      </small>
    </section>
  );
}
