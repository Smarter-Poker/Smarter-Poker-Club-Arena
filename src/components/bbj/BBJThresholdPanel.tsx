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
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import { money } from '../../utils/handFormat';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import { SpadeConsole } from '../console/SpadeConsole';
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

export default function BBJThresholdPanel({ clubId: clubParam, canEdit }: Props) {
  const toast = useToast();
  /* THE ROUTE NAMES A CLUB BY SLUG; THE TABLE KEYS IT BY UUID (2026-10-07).
     ClubSettingsPage passes its route param, which is a slug such as
     "deep-stack-society-11192" whenever the page was opened from a club link.
     `.eq('club_id', slug)` on a uuid column is Postgres 22P02, so the list
     never loaded and an add could never save: 69 such refusals on
     bbj_notify_thresholds in six hours of postgres_logs on 2026-10-07. The
     panel resolves the id once and asks nothing until it has a real one. */
  const [clubId, setClubId] = useState<string | null>(() => (isUUID(clubParam) ? clubParam : null));
  useEffect(() => {
    if (isUUID(clubParam)) {
      setClubId(clubParam);
      return undefined;
    }
    setClubId(null);
    let cancelled = false;
    void resolveClubUUID(clubParam).then((resolved) => {
      if (cancelled) return;
      if (isUUID(resolved)) setClubId(resolved);
      else
        reportError(new Error('club id unresolved'), 'BBJThresholdPanel.club_unresolved', {
          clubParam,
        });
    });
    return () => {
      cancelled = true;
    };
  }, [clubParam]);
  const [rows, setRows] = useState<Threshold[]>([]);
  const [jackpot, setJackpot] = useState<number | null>(null);
  const [amountText, setAmountText] = useState('');
  const [labelText, setLabelText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!clubId) return;
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
    if (!clubId) return;
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

  /* REBUILT ON THE CONSOLE 2026-09-14 (#ClubArenaConsole, the diamond crest:
     this is the jackpot's own panel). Re-rendered, not rewritten - every
     read, write, toast, guard and literal above this line is untouched. The
     `settings-section` shell is GONE: it is a bevelled realism card, and a
     painted frame inside it would be a frame on a frame. The amounts are rows
     on the black glass with an engraved rule between them, the two controls
     an operator types into are the only drawn things, and the actions are lit
     words. A member who cannot edit gets the flat closing cap instead of two
     plates, because they have no action to take. */
  return (
    <SpadeConsole
      as="section"
      className="bbj-threshold-panel"
      crest="diamond"
      eyebrow="Bad Beat Jackpot"
      title="Announcements"
      /* The live pool, so the number an operator picks is not a guess. A
         browsing figure, so it is compact; the thresholds below are terms and
         stay exact. */
      pill={jackpot !== null ? compactChips(jackpot) : 'Live'}
      pillInk="gold"
      foot={canEdit ? 'plates' : 'foot'}
      plates={
        canEdit
          ? {
              secondary: {
                label: 'Clear',
                ink: 'silver',
                onClick: () => {
                  setAmountText('');
                  setLabelText('');
                },
                disabled: busy || (!amountText && !labelText),
              },
              primary: {
                label: 'Add Announcement',
                ink: busy ? 'muted' : 'white',
                onClick: () => void add(),
                disabled: busy,
              },
            }
          : undefined
      }
    >
      <p className="bbj-threshold-panel__intro">
        Tell Your Members When The Jackpot Passes An Amount You Choose. Each Amount Is Announced
        Once, And It Arms Again The Next Time The Jackpot Is Hit.
        {jackpot !== null && (
          <>
            {' '}
            The Jackpot Is Currently <strong>{money(jackpot)} Chips</strong>.
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
              <span className="bbj-threshold-panel__amount sc-ink--silver">
                {money(row.amount)}
              </span>
              {/* An operator types this note, so it is DATA and the copy gates
                  never see it. Title Case at the print site (Dan 2026-09-14). */}
              {row.label && (
                <span className="bbj-threshold-panel__label sc-ink--muted">
                  {titleCase(row.label)}
                </span>
              )}
              <span
                className={`bbj-threshold-panel__state${row.enabled ? ' sc-ink--green' : ' bbj-threshold-panel__state--off sc-ink--muted'}`}
              >
                {row.enabled ? 'On' : 'Off'}
              </span>
              {canEdit && (
                <span className="bbj-threshold-panel__actions">
                  <button
                    type="button"
                    className="bbj-threshold-panel__word sc-ink--blue"
                    disabled={busy}
                    onClick={() => void toggle(row)}
                  >
                    {row.enabled ? 'Turn Off' : 'Turn On'}
                  </button>
                  <button
                    type="button"
                    className="bbj-threshold-panel__word sc-ink--red"
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
          <label className="bbj-threshold-panel__field" htmlFor="bbj-threshold-amount">
            <span className="bbj-threshold-panel__field-label sc-ink--blue">
              Announce At (Chips)
            </span>
            <input
              id="bbj-threshold-amount"
              className="bbj-threshold-panel__input"
              type="number"
              min="0"
              step="0.01"
              placeholder="10000"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
          </label>
          <label className="bbj-threshold-panel__field" htmlFor="bbj-threshold-label">
            <span className="bbj-threshold-panel__field-label sc-ink--blue">Note (Optional)</span>
            <input
              id="bbj-threshold-label"
              className="bbj-threshold-panel__input"
              type="text"
              maxLength={60}
              placeholder="Weekend Push"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
            />
          </label>
        </div>
      )}
    </SpadeConsole>
  );
}
