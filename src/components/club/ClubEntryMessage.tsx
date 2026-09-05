/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENTRY MESSAGE — the club speaks once, at the door (Dan, 2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "Club Message should appear as a 'full screen pop up' when you
 * enter the club, not anywhere 'baked into the screen'. [...] leave padding
 * around all edges top and bottom and create an 'X' off the message button. as
 * well as a don't show me this message again. and the only time a new pop up
 * will be displayed is if the club owner, co owner or admin creates a new
 * message."
 *
 * WHAT THIS REPLACES. The club message was baked into the lobby in THREE
 * places, and they disagreed with each other:
 *
 *   .club-mobile-owner-message   a phone strip with its own inline editor
 *   <ClubOwnerMessage>           a desktop button in the rail, opening a modal
 *   .lobby-top__notice           the welcome block, editable in place
 *
 * Three editors on one column, with three different length caps - 72, 240 and
 * 72 - against a server that accepts 240. A message written in the desktop
 * modal and then touched on a phone was silently cut to 72 characters. One
 * surface, one cap, and that whole class of bug goes with it.
 *
 * WHEN IT SPEAKS. `fn_get_club_entry_message` answers `should_show`, and the
 * client does not second-guess it. The rule lives in one place because it has
 * to be the same rule for every device the person owns: show when a message
 * exists and this person has not retired THIS revision of it. Revisions come
 * from `clubs.message_revision`, which both staff writers already bump, so
 * "the owner wrote a new message" is a fact the database already knows rather
 * than something the client has to infer from changed text.
 *
 * THE TWO WAYS OUT, which are not the same promise:
 *
 *   X            close it now. Nothing is written. The message is still the
 *                club's current message, so it greets them again next visit -
 *                that is what a day's message is for. A tap beside the card is
 *                the same promise by a different gesture.
 *   Do Not Show  writes the dismissal. Silent until staff write a NEW message,
 *                at which point the club has something else to say and says it.
 *
 * Collapsing those two into one control was the tempting simplification and it
 * would have been wrong: an X that silences a club forever is a trap, and a
 * greeting with no quick way out is an obstacle.
 *
 * ONE RULE, ONE DOOR (Dan, 2026-09-04): "THE CLUB MESSAGE DOESN'T POP UP AT
 * ALL NOW... FIX IT AT ITS CORE. THEN FIX IT SO IT ACTUALLY WORKS, NEVER
 * BLOCKS ENTIRE PAGES, AND CAN BE MANAGED FROM THE TABLE MANEGEMENT PAGE BY
 * CLUB OR UNION OWNERS."
 *
 * The popup went silent because the server's should_show had been tied to a
 * column only some writers maintained. That rule now lives in one place
 * (migration 20260905000730: a trigger on clubs, one predicate for who may
 * write). Two things changed HERE as a result:
 *
 *   can_manage     the reply now says whether THIS person may write the
 *                  message - the club's owner or staff, or an overseer of the
 *                  club's union. The lobby page cannot tell a union owner from
 *                  a player on its own, so the server's word is what offers
 *                  the editor, alongside the page's own role read.
 *   closeOnOverlay a backdrop that swallows taps is the piece of "blocks the
 *                  page" that a small card does not fix by being small.
 *                  Tapping beside the card closes it and writes nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './ClubEntryMessage.css';

/**
 * The cap `fn_set_club_lobby_message` enforces server-side. One constant, so
 * the counter under the box and the server agree about what fits.
 */
export const CLUB_ENTRY_MESSAGE_MAX = 240;

export interface ClubEntryMessageProps {
  clubId: string;
  clubName: string;
  /** Owner, co-owner, admin or manager: may write the message. */
  canEdit: boolean;
  /** Keeps the lobby's club object the one source after a staff save. */
  onMessageSaved?: (message: string | null) => void;
  /** Opens the club announcements page. */
  onOpenAnnouncements: () => void;
  /** House toast layer. Title Case and em dash rules are applied there. */
  onToast: (kind: 'success' | 'error', text: string) => void;
}

interface EntryMessageState {
  message: string;
  revision: number;
  /** The server's answer to "may this person write it", union ownership included. */
  canManage: boolean;
}

export default function ClubEntryMessage({
  clubId,
  clubName,
  canEdit: canEditByRole,
  onMessageSaved,
  onOpenAnnouncements,
  onToast,
}: ClubEntryMessageProps) {
  const [entry, setEntry] = useState<EntryMessageState | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  /*
    Asked once per club entry. Not on an interval and not on a realtime event:
    a popup that appears over a player mid-session because an owner saved a
    typo is an interruption, not a greeting. The door is the door.
  */
  useEffect(() => {
    if (!clubId) return;
    let live = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_get_club_entry_message', {
          p_club_id: clubId,
        });
        if (error) throw error;
        if (!live) return;
        const result = (data || {}) as {
          ok?: boolean;
          message?: string | null;
          revision?: number | null;
          should_show?: boolean;
          can_manage?: boolean;
        };
        if (!result.ok || !result.should_show) return;
        const text = result.message?.trim();
        if (!text) return;
        setEntry({
          message: text,
          revision: Number(result.revision ?? 0),
          canManage: result.can_manage === true,
        });
        setOpen(true);
      } catch (e) {
        /* The greeting is the least important thing on this page. A failed
           read closes the door quietly and the lobby loads exactly as it
           would have. */
        reportError(e, 'ClubEntryMessage.read');
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId]);

  const close = useCallback(() => setOpen(false), []);

  const dismissForever = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      const { data, error } = await supabase.rpc('fn_dismiss_club_message', {
        p_club_id: clubId,
      });
      if (error) throw error;
      if (!(data as { ok?: boolean } | null)?.ok) throw new Error('dismiss rejected');
      setOpen(false);
    } catch (e) {
      reportError(e, 'ClubEntryMessage.dismiss');
      /* Say so. Silently closing would look identical to success and the
         message would be back tomorrow with no explanation. */
      onToast('error', 'Could Not Save That Preference. The Message Was Closed For Now');
      setOpen(false);
    } finally {
      setDismissing(false);
    }
  };

  const save = async () => {
    if (saving) return;
    const next = draft.replace(/\s+/g, ' ').trim().slice(0, CLUB_ENTRY_MESSAGE_MAX);
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('fn_set_club_lobby_message', {
        p_club_id: clubId,
        p_message: next,
      });
      if (error) throw error;
      const result = (data || {}) as {
        ok?: boolean;
        reason?: string;
        lobby_message?: string | null;
        revision?: number | null;
      };
      if (!result.ok) {
        onToast(
          'error',
          result.reason === 'not_authorized'
            ? 'Only Club Staff Can Write The Club Message'
            : 'Could Not Save The Club Message'
        );
        return;
      }
      onMessageSaved?.(result.lobby_message ?? null);
      onToast('success', 'Club Message Updated');
      const saved = result.lobby_message?.trim();
      if (!saved) {
        /* Cleared. There is nothing left to greet anybody with. */
        setOpen(false);
        return;
      }
      setEntry({ message: saved, revision: Number(result.revision ?? 0), canManage: true });
      setEditing(false);
    } catch (e) {
      reportError(e, 'ClubEntryMessage.save');
      onToast('error', 'Could Not Save The Club Message');
    } finally {
      setSaving(false);
    }
  };

  if (!entry) return null;

  /* The page's role read OR the server's word. The page knows club staff; only
     the server knows the union that oversees this club. */
  const canEdit = canEditByRole || entry.canManage;

  return (
    <Modal
      isOpen={open}
      onClose={close}
      /* Still the `fullscreen` size class: ClubEntryMessage.css keys the
         contained 480px card to it and theGreetingFillsThePanel pins that. */
      size="fullscreen"
      showCloseButton={false}
      /* Tapping beside the card closes it and writes nothing - the same
         promise the X makes. A backdrop that swallows taps is a wall. */
      closeOnOverlay
      className="club-entry-message-modal"
      ariaLabel={`Club Message From ${clubName}`}
    >
      <div className="club-entry-message">
        {/* The X. Its own control, in the corner, above everything, and large
            enough to hit on a phone without aiming. */}
        <button
          type="button"
          className="club-entry-message__close"
          onClick={close}
          aria-label="Close Club Message"
        >
          <span aria-hidden="true">&#215;</span>
        </button>

        <div className="club-entry-message__body">
          <span className="club-entry-message__eyebrow">A Message From</span>
          <h2 className="club-entry-message__club">{clubName}</h2>

          {editing ? (
            <div className="club-entry-message__editor">
              {/* No apostrophe: check-title-case reads an escaped apostrophe as
                  a word boundary and then sees a lower-case letter. */}
              <label htmlFor="club-entry-message-input">
                The Message For Today, Or Anything Custom
              </label>
              <textarea
                id="club-entry-message-input"
                value={draft}
                maxLength={CLUB_ENTRY_MESSAGE_MAX}
                rows={4}
                placeholder="Tonight At 8, Double Rakeback On Every Nine Handed Table"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="club-entry-message__editor-foot">
                <span>
                  {draft.length}/{CLUB_ENTRY_MESSAGE_MAX}
                </span>
                <div className="club-entry-message__editor-actions">
                  <button
                    type="button"
                    className="club-entry-message__btn"
                    disabled={saving}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="club-entry-message__btn club-entry-message__btn--primary"
                    disabled={saving}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving' : 'Save Message'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="club-entry-message__copy">{entry.message}</p>
          )}
        </div>

        <div className="club-entry-message__foot">
          {canEdit && !editing && (
            <button
              type="button"
              className="club-entry-message__btn"
              onClick={() => {
                setDraft(entry.message);
                setEditing(true);
              }}
            >
              Edit Message
            </button>
          )}

          <button
            type="button"
            className="club-entry-message__btn"
            onClick={() => {
              close();
              onOpenAnnouncements();
            }}
          >
            View Club Announcements
          </button>

          {/* The other way out, and deliberately worded as the promise it
              makes: quiet until the club has something NEW to say. */}
          <button
            type="button"
            className="club-entry-message__btn club-entry-message__btn--quiet"
            disabled={dismissing}
            onClick={() => void dismissForever()}
          >
            {dismissing ? 'Saving' : 'Do Not Show Me This Message Again'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
