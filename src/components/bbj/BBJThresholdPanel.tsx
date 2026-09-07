/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLUB'S OWN JACKPOT ANNOUNCEMENTS
 *  BBJ build plan phase 3.4 (docs/BBJ-BUILD-PLAN.md), 2026-09-07
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS AT ALL. Phase 3.4 shipped the whole sending half - the
 * `bbj_notify_thresholds` table, the five-minute sender, the crossing ledger
 * that makes it say a thing once - and no way for a club to set a number. A
 * "club setting" nobody can set is not a feature, it is a table.
 *
 * The history of this very page argues the point better than I can. The BBJ
 * Rake switch that used to sit here wrote a column NOTHING read, so an owner
 * could turn it off and every table went on taking the rake; it was removed on
 * 2026-09-05 with the note that "showing it did the one thing worse than not
 * offering the control, which is to say it had been used." This is the exact
 * mirror: a reader with no control. Both halves have to exist or neither is
 * honest.
 *
 * NOT GATED ON `inUnion`, unlike the rake settings above it. A union banks one
 * jackpot for all of its clubs, but each club notifies its OWN members - so a
 * club inside a union still has a real decision to make here, about its own
 * players, even though the pool it watches is not its own. The panel says so
 * rather than hiding the control.
 *
 * WRITES GO STRAIGHT THROUGH RLS. `bbj_thresholds_admin_write` scopes every
 * insert, update and delete to `fn_is_club_admin_uid(club_id)`, and the table
 * grants only reach `authenticated`; there is no RPC in between to get out of
 * step with the policy. A non-admin member can read the club's thresholds and
 * gets no write buttons, which matches what the database would tell them
 * anyway.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { watchBbjPool } from '../../lib/bbjPoolFeed';
import { money } from '../../utils/handFormat';
import './BBJThresholdPanel.css';

interface Threshold {
  id: string;
  amount: number;
  label: string | null;
  enabled: boolean;
}

interface Props {
  clubId: string;
  /** Only an admin sees the controls. Everyone else sees the list. */
  canEdit: boolean;
}

export default function BBJThresholdPanel({ clubId, canEdit }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<Threshold[]>([]);
  const [jackpot, setJackpot] = useState<number | null>(null);
  const [amountText, setAmountText] = useState('');
  const [labelText, setLabelText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('bbj_notify_thresholds')
      .select('id, amount, label, enabled')
      .eq('club_id', clubId)
      .order('amount', { ascending: true });
    if (error) {
      reportError(error, 'BBJThresholdPanel.read_failed', { clubId });
      setLoaded(true);
      return;
    }
    setRows(
      (data || []).map((r) => ({
        id: r.id as string,
        amount: Number(r.amount),
        label: (r.label as string | null) ?? null,
        enabled: Boolean(r.enabled),
      }))
    );
    setLoaded(true);
  }, [clubId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The live figure, from the one shared source every other jackpot surface
     reads (phase 3.2). An operator picking a number needs to see where the
     jackpot actually is, or the number they pick is a guess. */
  useEffect(() => {
    if (!clubId) return undefined;
    return watchBbjPool(clubId, (snap) => setJackpot(snap.mainBalance));
  }, [clubId]);

  const add = useCallback(async () => {
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter An Amount Above Zero.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('bbj_notify_thresholds').insert({
      club_id: clubId,
      amount,
      label: labelText.trim() || null,
    });
    setBusy(false);
    if (error) {
      /* The unique index is (club_id, amount), so the ordinary refusal here is
         "you already have that number" rather than anything alarming. */
      const duplicate = /duplicate|unique/i.test(error.message || '');
      toast.error(
        duplicate
          ? 'That Amount Is Already On The List.'
          : 'Could Not Save That Threshold. Please Try Again.'
      );
      if (!duplicate) reportError(error, 'BBJThresholdPanel.insert_failed', { clubId, amount });
      return;
    }
    setAmountText('');
    setLabelText('');
    toast.success('Threshold Added. Your Members Will Be Told Once The Jackpot Passes It.');
    void load();
  }, [amountText, labelText, clubId, toast, load]);

  const toggle = useCallback(
    async (row: Threshold) => {
      setBusy(true);
      const { error } = await supabase
        .from('bbj_notify_thresholds')
        .update({ enabled: !row.enabled, updated_at: new Date().toISOString() })
        .eq('id', row.id);
      setBusy(false);
      if (error) {
        reportError(error, 'BBJThresholdPanel.toggle_failed', { id: row.id });
        toast.error('Could Not Change That Threshold. Please Try Again.');
        return;
      }
      void load();
    },
    [toast, load]
  );

  const remove = useCallback(
    async (row: Threshold) => {
      setBusy(true);
      const { error } = await supabase.from('bbj_notify_thresholds').delete().eq('id', row.id);
      setBusy(false);
      if (error) {
        reportError(error, 'BBJThresholdPanel.delete_failed', { id: row.id });
        toast.error('Could Not Remove That Threshold. Please Try Again.');
        return;
      }
      toast.success('Threshold Removed.');
      void load();
    },
    [toast, load]
  );

  if (!loaded) return null;

  return (
    <section className="settings-section bbj-threshold-panel">
      <h3>Bad Beat Jackpot Announcements</h3>

      <p className="bbj-threshold-panel__intro">
        Tell Your Members When The Jackpot Passes An Amount You Choose. Each Amount Is Announced
        Once, And It Arms Again The Next Time The Jackpot Is Hit.
        {jackpot !== null && (
          <>
            {' '}
            The Jackpot Is Currently <strong>${money(jackpot)}</strong>.
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="bbj-threshold-panel__empty">
          No Announcements Set. Your Members Are Not Told When The Jackpot Grows.
        </p>
      ) : (
        <ul className="bbj-threshold-panel__list">
          {rows.map((row) => (
            <li key={row.id} className="bbj-threshold-panel__row">
              <span className="bbj-threshold-panel__amount">${money(row.amount)}</span>
              {row.label && <span className="bbj-threshold-panel__label">{row.label}</span>}
              <span
                className={`bbj-threshold-panel__state${row.enabled ? '' : ' bbj-threshold-panel__state--off'}`}
              >
                {row.enabled ? 'On' : 'Off'}
              </span>
              {canEdit && (
                <span className="bbj-threshold-panel__actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void toggle(row)}
                  >
                    {row.enabled ? 'Turn Off' : 'Turn On'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => void remove(row)}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="bbj-threshold-panel__add">
          <div className="form-group">
            <label htmlFor="bbj-threshold-amount">Announce At ($)</label>
            <input
              id="bbj-threshold-amount"
              type="number"
              min="0"
              step="0.01"
              placeholder="10000"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="bbj-threshold-label">Note (Optional)</label>
            <input
              id="bbj-threshold-label"
              type="text"
              maxLength={60}
              placeholder="Weekend Push"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void add()}
          >
            Add Announcement
          </button>
        </div>
      )}
    </section>
  );
}
