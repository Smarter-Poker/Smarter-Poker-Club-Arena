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
import { watchBbjMini, setBbjMiniEnabled, type BbjMiniSnapshot } from '../../lib/bbjMiniFeed';
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
    default:
      return 'The Mini Jackpot Setting Could Not Be Saved. Nothing Changed.';
  }
}

export default function BBJMiniPanel({ clubId, canEdit }: Props) {
  const toast = useToast();
  const [mini, setMini] = useState<BbjMiniSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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
        toast.error(refusalText(res.reason).replace(/&apos;/g, "'"));
        return;
      }
      toast.success(res.enabled ? 'Mini Jackpot Is On' : 'Mini Jackpot Is Off');
    } finally {
      setBusy(false);
    }
  }, [mini, busy, clubId, toast]);

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
          This Club Belongs To A Union, So Its Mini Jackpot Pays From The Union’s Shared Reserve.
          Only The Union Can Turn It On Or Off.
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

      <small className="form-hint" style={{ display: 'block' }}>
        The Mini Pauses On Its Own While The Backup Pool Is At Its Floor, And Resumes When It
        Refills. Last 30 Days: {mini.hits30d.toLocaleString('en-US')}{' '}
        {mini.hits30d === 1 ? 'Mini Jackpot' : 'Mini Jackpots'}, {chips(mini.paid30d)} Chips Paid.
      </small>
    </section>
  );
}
