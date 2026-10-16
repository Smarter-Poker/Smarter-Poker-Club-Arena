import { useCallback, useEffect, useState } from 'react';
import Modal from '../common/Modal';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import { useAuthUser } from '../../hooks/useAuthUser';
import { titleCase } from '../../utils/titleCase';
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
}

export default function ClubEntryMessage({
  clubId,
  clubName,
  canEdit,
  onMessageSaved,
  onToast,
}: ClubEntryMessageProps) {
  const { user } = useAuthUser();
  const [announcements, setAnnouncements] = useState<
    Array<{ id: string; title: string; content: string }>
  >([]);
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
    setOpen(false);
    setEntry(null);
    setAnnouncements([]);
    if (!clubId || !user?.id) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const dailyKey = `sp-club-greeting-day:${user.id}:${clubId}`;
    const alreadyShown = () => {
      try {
        return localStorage.getItem(dailyKey) === today;
      } catch {
        return false;
      }
    };
    if (alreadyShown()) return;
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
        };
        if (!result.ok) return;
        const text = result.should_show ? result.message?.trim() || '' : '';
        const { data: posts, error: postsError } = await supabase
          .from('club_announcements')
          .select('id,title,content')
          .eq('club_id', clubId)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(200);
        if (postsError) reportError(postsError, 'ClubEntryMessage.announcements');
        if (!live || alreadyShown()) return;
        const available = postsError ? [] : posts || [];
        if (!text && !available.length) return;
        // Mark at the actual show transition, never on an empty or failed read.
        try {
          localStorage.setItem(dailyKey, today);
        } catch {
          /* Private storage. */
        }
        setEntry({ message: text, revision: Number(result.revision ?? 0) });
        setAnnouncements(available);
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
  }, [clubId, user?.id]);

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
      setEntry({ message: saved, revision: Number(result.revision ?? 0) });
      setEditing(false);
    } catch (e) {
      reportError(e, 'ClubEntryMessage.save');
      onToast('error', 'Could Not Save The Club Message');
    } finally {
      setSaving(false);
    }
  };

  if (!entry) return null;

  return (
    <Modal
      isOpen={open}
      onClose={close}
      size="fullscreen"
      showCloseButton={false}
      closeOnOverlay={false}
      className="club-entry-message-modal"
      ariaLabel={`Club Message From ${clubName}`}
    >
      <SpadeConsole
        className="club-entry-message"
        eyebrow={titleCase(clubName)}
        title="Club Message"
        pill="Today"
        onClose={close}
        plates={{
          secondary: {
            label: dismissing ? 'Saving' : 'Do Not Show Again',
            disabled: dismissing,
            onClick: () => void dismissForever(),
          },
          primary: { label: 'Enter Lobby', onClick: close },
        }}
      >
        <div className="club-entry-message__body">
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
            <p className="club-entry-message__copy">{titleCase(entry.message)}</p>
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

          {announcements.map((post) => (
            <article className="club-entry-message__announcement" key={post.id}>
              <h3 className="sc-label sc-ink--blue">{titleCase(post.title)}</h3>
              <p className="sc-copy sc-ink--silver">{titleCase(post.content)}</p>
            </article>
          ))}
        </div>
      </SpadeConsole>
    </Modal>
  );
}
