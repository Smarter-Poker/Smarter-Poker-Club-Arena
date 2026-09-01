/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB OWNER MESSAGE — the top line of the lobby rail (Dan, 2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "on desktop in the club arena, the 'welcome to club jaqk' thats
 * on the bottom of the wallets should be at the top above the club card, and
 * that should be the 'custom clickable message' for the club owners to put the
 * days message, or something custom".
 *
 * Three things had to change, and they are all here:
 *
 *   WHERE   It used to be the last child of the wallet stack, so on a desktop
 *           rail it sat below Club Bank, Promo, Agent, Player, Rake, BBJ and
 *           Spins - past the fold on a short viewport, and read by nobody. It
 *           is now the FIRST child of `.lobby-top`, above the club card.
 *
 *   WHAT    It used to print `tagline`, which is the club's PERMANENT identity
 *           line: written once in the opening wizard, tracked by the opening
 *           checklist, printed on the invite page. A message meant to change
 *           daily cannot share that column. `clubs.lobby_message` is its own
 *           field (migration 20260902113000_club_lobby_owner_message), and
 *           `tagline` remains the fallback so nothing a club already wrote
 *           disappears.
 *
 *   CLICK   It used to be a `<p>`. It is a button now. Everybody who taps it
 *           gets the message in full - the strip is one clipped line and a
 *           day's message routinely will not fit - plus a way through to the
 *           club's announcements. Owners, co-owners, admins and managers get
 *           the editor in the same panel, so the message is written where it
 *           is read rather than three pages away.
 *
 * The write goes through `fn_set_club_lobby_message`, never a direct UPDATE on
 * `clubs`: that row also carries treasury, rake and level columns, and the
 * client is never handed a hammer that wide. The function decides who may
 * write, collapses whitespace and caps the length.
 */

import { useEffect, useState } from 'react';
import Modal from '../common/Modal';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './ClubOwnerMessage.css';

/** Matches the cap `fn_set_club_lobby_message` enforces server-side. */
export const CLUB_LOBBY_MESSAGE_MAX = 240;

export interface ClubOwnerMessageProps {
  clubId: string;
  clubName: string;
  /** `clubs.lobby_message` - the owner's custom / day's message. */
  message?: string | null;
  /** `clubs.tagline` - the permanent identity line, used when there is no message. */
  tagline?: string | null;
  /** Owner, co-owner, admin or manager: may write the message. */
  canEdit: boolean;
  /** Lifts the saved value so the lobby's club object stays the one source. */
  onMessageSaved: (message: string | null) => void;
  /** Opens the club announcements page. */
  onOpenAnnouncements: () => void;
  /** House toast layer. Title Case and em dash rules are applied there. */
  onToast: (kind: 'success' | 'error', text: string) => void;
}

/**
 * The line the strip prints. Never empty: a rail with a blank first row reads
 * as a broken page, and this element occupied the same space before this
 * change with exactly this fallback.
 */
export function clubOwnerMessageLine(
  message: string | null | undefined,
  tagline: string | null | undefined,
  clubName: string
): string {
  return message?.trim() || tagline?.trim() || `Welcome To ${clubName}`;
}

export default function ClubOwnerMessage({
  clubId,
  clubName,
  message,
  tagline,
  canEdit,
  onMessageSaved,
  onOpenAnnouncements,
  onToast,
}: ClubOwnerMessageProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const line = clubOwnerMessageLine(message, tagline, clubName);

  /* Re-seed the editor whenever the panel opens OR the stored message changes
     underneath it (another admin saving, a club switch in the same mount).
     Seeding only on mount left a stale draft that would have overwritten the
     newer message the moment somebody pressed Save. */
  useEffect(() => {
    if (open) setDraft(message?.trim() || '');
  }, [open, message]);

  const save = async () => {
    if (saving) return;
    const next = draft.replace(/\s+/g, ' ').trim().slice(0, CLUB_LOBBY_MESSAGE_MAX);
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
      onMessageSaved(result.lobby_message ?? null);
      onToast('success', 'Club Message Updated');
      setOpen(false);
    } catch (e) {
      reportError(e, 'ClubOwnerMessage.save');
      onToast('error', 'Could Not Save The Club Message');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="lobby-top__house-welcome"
        onClick={() => setOpen(true)}
        title={line}
        aria-label={
          canEdit ? `Club Message: ${line}. Open To Edit` : `Club Message: ${line}. Open To Read`
        }
      >
        {line}
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Club Message"
        size="medium"
        showCloseButton
        className="club-owner-message-modal"
      >
        <div className="club-owner-message">
          {/* The full message, unclipped. This is the reason a reader taps a
              one-line strip that ends in an ellipsis. */}
          <p className="club-owner-message__full">{line}</p>

          {canEdit && (
            <div className="club-owner-message__editor">
              {/* No apostrophe: check-title-case reads `&apos;` as a word
                  boundary and then sees a lower-case "s". "The Day's Message"
                  fails the gate; this says the same thing and passes. */}
              <label htmlFor="club-owner-message-input">
                The Message For Today, Or Anything Custom
              </label>
              <textarea
                id="club-owner-message-input"
                value={draft}
                maxLength={CLUB_LOBBY_MESSAGE_MAX}
                rows={3}
                placeholder="Tonight At 8, Double Rakeback On Every Nine Handed Table"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="club-owner-message__editor-foot">
                <span>
                  {draft.length}/{CLUB_LOBBY_MESSAGE_MAX}
                </span>
                <div className="club-owner-message__editor-actions">
                  {/* Clearing is a real action, not "type a space": the RPC
                      turns an empty string into NULL, which puts the strip
                      back on the tagline. Without this there is no way out of
                      a message once one is written. */}
                  <button
                    type="button"
                    className="club-owner-message__btn"
                    disabled={saving || draft.trim().length === 0}
                    onClick={() => setDraft('')}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="club-owner-message__btn club-owner-message__btn--primary"
                    disabled={saving}
                    onClick={() => void save()}
                  >
                    {saving ? 'Saving' : 'Save Message'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Announcements are the club's longer form surface and already
              exist. A one-line strip that opens a panel with no way onward is
              a dead end for the reader who tapped it wanting more. */}
          <button
            type="button"
            className="club-owner-message__btn club-owner-message__announcements"
            onClick={() => {
              setOpen(false);
              onOpenAnnouncements();
            }}
          >
            View Club Announcements
          </button>
        </div>
      </Modal>
    </>
  );
}
