import { useCallback, useEffect, useRef, useState } from 'react';
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

// Reuse only an in-flight entry request during React StrictMode's effect
// replay. A second claim would consume the receipt before the live effect
// receives it. Later entries always ask the server for newly published news.
interface EntryNewsResult {
  data: unknown;
  error: unknown;
}
const entryRequests = new Map<string, Promise<EntryNewsResult>>();
function claimEntryNews(userId: string, clubId: string) {
  const key = `${userId}:${clubId}`;
  let request = entryRequests.get(key);
  if (!request) {
    request = Promise.resolve(
      supabase.rpc('fn_claim_club_entry_news', { p_club_id: clubId })
    ).finally(() => entryRequests.delete(key));
    entryRequests.set(key, request);
  }
  return request;
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
  const scopeKey = `${user?.id || ''}:${clubId}`;
  const activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const scopeEpoch = useRef(0);

  /*
    Claims unseen news once per club entry. Receipts live on the server, so
    another day, browser or device cannot replay the same news. Not on an
    interval and not on a realtime event:
    a popup that appears over a player mid-session because an owner saved a
    typo is an interruption, not a greeting. The door is the door.
  */
  useEffect(() => {
    setOpen(false);
    setEntry(null);
    setAnnouncements([]);
    setEditing(false);
    setSaving(false);
    if (!clubId || !user?.id) return;
    let live = true;
    void (async () => {
      try {
        const { data, error } = await claimEntryNews(user.id, clubId);
        if (error) throw error;
        if (!live) return;
        const result = (data || {}) as {
          ok?: boolean;
          message?: string | null;
          revision?: number | null;
          should_show?: boolean;
          announcements?: Array<{ id: string; title: string; content: string }>;
        };
        if (!result.ok) return;
        const text = result.should_show ? result.message?.trim() || '' : '';
        const available = result.announcements || [];
        if (!live || (!text && !available.length)) return;
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
      scopeEpoch.current += 1;
    };
  }, [clubId, user?.id]);

  const close = useCallback(() => {
    scopeEpoch.current += 1;
    setSaving(false);
    setOpen(false);
  }, []);

  const save = async () => {
    if (saving || !user?.id || !clubId) return;
    const epoch = scopeEpoch.current;
    const isCurrent = () => activeScope.current === scopeKey && scopeEpoch.current === epoch;
    const next = draft.replace(/\s+/g, ' ').trim().slice(0, CLUB_ENTRY_MESSAGE_MAX);
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('fn_set_club_lobby_message', {
        p_club_id: clubId,
        p_message: next,
      });
      if (error) throw error;
      if (!isCurrent()) return;
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
      const saved = result.lobby_message?.trim();
      if (!saved) {
        /* Cleared. There is nothing left to greet anybody with. */
        onMessageSaved?.(null);
        onToast('success', 'Club Message Updated');
        setOpen(false);
        return;
      }
      // The staff member is seeing the edited copy in this same popup.
      // Record that delivery too, so their next entry does not replay it.
      const { data: claimed, error: claimError } = await claimEntryNews(user.id, clubId);
      if (!isCurrent()) return;
      if (claimError) throw claimError;
      const news = claimed as {
        ok?: boolean;
        message?: string;
        revision?: number;
        should_show?: boolean;
        announcements?: Array<{ id: string; title: string; content: string }>;
      } | null;
      if (!news?.ok) throw new Error('Could not record the saved news delivery');
      // Render precisely the claimed snapshot: another staff save may have
      // superseded our write while its response was in flight.
      const text = news.should_show ? news.message?.trim() || '' : '';
      const posts = news.announcements || [];
      onMessageSaved?.(text || result.lobby_message || null);
      onToast('success', 'Club Message Updated');
      setEntry({ message: text, revision: Number(news.revision ?? 0) });
      setAnnouncements(posts);
      setEditing(false);
      if (!text && !posts.length) setOpen(false);
    } catch (e) {
      reportError(e, 'ClubEntryMessage.save');
      if (isCurrent()) onToast('error', 'Could Not Save The Club Message');
    } finally {
      if (isCurrent()) setSaving(false);
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
        pill="News"
        onClose={close}
        foot="foot"
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
          <button type="button" className="club-entry-message__btn" onClick={close}>
            Enter Lobby
          </button>
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
