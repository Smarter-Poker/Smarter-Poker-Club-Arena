import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLUB_MESSAGE_LIMITS,
  clubMessageManagementService,
  type ClubIdentityMessages,
  type ManagedClubAnnouncement,
} from '../../services/ClubMessageManagementService';
import { confirmDialog } from '../common/confirmDialog';
import { useToast } from '../common/Toast';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { isManagementContentConflict } from '../../services/ManagementContentError';
import styles from './ClubMessageManagementPanel.module.css';

const EMPTY_IDENTITY: ClubIdentityMessages = { tagline: '', lobbyMessage: '', description: '' };
const EMPTY_ANNOUNCEMENT = { title: '', content: '', isPinned: false, isActive: true };

function CharacterCount({ id, value, limit }: { id: string; value: string; limit: number }) {
  return (
    <small id={id} className={value.length === limit ? styles.atLimit : ''} aria-live="polite">
      {value.length}/{limit}
    </small>
  );
}

export default function ClubMessageManagementPanel({
  clubId,
  clubName,
  onDirtyChange,
}: {
  clubId: string;
  clubName: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [identity, setIdentity] = useState<ClubIdentityMessages>(EMPTY_IDENTITY);
  const [savedIdentity, setSavedIdentity] = useState<ClubIdentityMessages | null>(null);
  const [identityRevision, setIdentityRevision] = useState<number | null>(null);
  const [announcements, setAnnouncements] = useState<ManagedClubAnnouncement[]>([]);
  const [draft, setDraft] = useState(EMPTY_ANNOUNCEMENT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [busyAnnouncement, setBusyAnnouncement] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadEpochRef = useRef(0);

  const identityDirty = useMemo(
    () => Boolean(savedIdentity) && JSON.stringify(identity) !== JSON.stringify(savedIdentity),
    [identity, savedIdentity]
  );
  const announcementDirty =
    Boolean(editingId) ||
    Boolean(draft.title.trim()) ||
    Boolean(draft.content.trim()) ||
    draft.isPinned ||
    !draft.isActive;
  const dirty = identityDirty || announcementDirty;

  useEffect(() => {
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = useCallback(async () => {
    const requestId = ++loadEpochRef.current;
    const isCurrent = () => loadEpochRef.current === requestId;
    setLoading(true);
    setLoadError(null);
    try {
      const value = await clubMessageManagementService.get(clubId);
      if (!isCurrent()) return;
      setIdentity(value.identity);
      setSavedIdentity(value.identity);
      setIdentityRevision(value.identityRevision);
      setAnnouncements(value.announcements);
      setDraft(EMPTY_ANNOUNCEMENT);
      setEditingId(null);
      setEditingRevision(0);
      setRemoteUpdate(false);
      dirtyRef.current = false;
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : 'Could not load club messages.';
      setLoadError(message);
      setIdentityRevision(null);
      toast.error(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [clubId, toast]);

  useEffect(() => {
    setIdentity(EMPTY_IDENTITY);
    setSavedIdentity(null);
    setIdentityRevision(null);
    setDraft(EMPTY_ANNOUNCEMENT);
    setEditingId(null);
    setEditingRevision(0);
    void load();
  }, [load]);

  useMasterBusSubscriptions(
    ['CLUB_UPDATED', 'ANNOUNCEMENT_CHANGED'],
    (payload) => {
      if ((payload as { clubId?: string })?.clubId !== clubId || savingRef.current) return;
      if (dirtyRef.current) setRemoteUpdate(true);
      else void load();
    },
    { debounce: 200 }
  );

  const saveIdentity = async () => {
    if (identityRevision === null || loadError || !identityDirty) return;
    savingRef.current = true;
    setSavingIdentity(true);
    try {
      const saved = await clubMessageManagementService.saveIdentity(
        clubId,
        identity,
        identityRevision
      );
      setIdentity(saved.identity);
      setSavedIdentity(saved.identity);
      setIdentityRevision(saved.revision);
      setRemoteUpdate(false);
      toast.success('Club messages saved.');
    } catch (error) {
      if (isManagementContentConflict(error)) setRemoteUpdate(true);
      toast.error(error instanceof Error ? error.message : 'Could not save club messages.');
    } finally {
      savingRef.current = false;
      setSavingIdentity(false);
    }
  };

  const loadLatest = async () => {
    if (
      dirtyRef.current &&
      !(await confirmDialog({
        message: 'Discard your club-message draft and load the latest saved version?',
        variant: 'danger',
      }))
    )
      return;
    await load();
  };

  const saveAnnouncement = async () => {
    if (identityRevision === null || loadError) return;
    savingRef.current = true;
    setBusyAnnouncement(editingId || 'new');
    try {
      await clubMessageManagementService.manageAnnouncement(
        clubId,
        'save',
        {
          id: editingId || undefined,
          ...draft,
        },
        editingId ? editingRevision : 0
      );
      toast.success(editingId ? 'Announcement updated.' : 'Announcement published.');
      setDraft(EMPTY_ANNOUNCEMENT);
      setEditingId(null);
      await load();
    } catch (error) {
      if (isManagementContentConflict(error)) setRemoteUpdate(true);
      toast.error(error instanceof Error ? error.message : 'Could not save the announcement.');
    } finally {
      savingRef.current = false;
      setBusyAnnouncement(null);
    }
  };

  const mutateAnnouncement = async (
    announcement: ManagedClubAnnouncement,
    action: 'delete' | 'set_pin' | 'set_active',
    value?: boolean
  ) => {
    if (
      action === 'delete' &&
      !(await confirmDialog({
        message: `Delete “${announcement.title}”? This cannot be undone.`,
        variant: 'danger',
      }))
    )
      return;
    setBusyAnnouncement(announcement.id);
    savingRef.current = true;
    try {
      await clubMessageManagementService.manageAnnouncement(
        clubId,
        action,
        {
          ...announcement,
          isPinned: action === 'set_pin' ? value : announcement.isPinned,
          isActive: action === 'set_active' ? value : announcement.isActive,
        },
        announcement.revision
      );
      await load();
    } catch (error) {
      if (isManagementContentConflict(error)) setRemoteUpdate(true);
      toast.error(error instanceof Error ? error.message : 'Could not update the announcement.');
    } finally {
      savingRef.current = false;
      setBusyAnnouncement(null);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="club-message-management-title">
      <header className={styles.heading}>
        <div>
          <span>Club Message Management</span>
          <h2 id="club-message-management-title">Every Player-Facing Club Message</h2>
          <p>{clubName} · Edit Identity Copy And Announcement Banners From One Governed Surface.</p>
        </div>
        <span className={styles.limitKey}>Limits Are Enforced In The Database</span>
      </header>

      {loadError && (
        <div className={styles.safetyNotice} role="alert">
          <strong>Message Editing Is Locked</strong>
          <span>{loadError} Blank Values Will Not Replace The Saved Club Copy.</span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            Try Again
          </button>
        </div>
      )}
      {remoteUpdate && (
        <div className={styles.safetyNotice} role="status" aria-live="polite">
          <strong>A Newer Version Is Available</strong>
          <span>Your Local Draft Is Intact. Loading The Latest Version Will Discard It.</span>
          <button type="button" onClick={() => void loadLatest()} disabled={loading}>
            Load Latest
          </button>
        </div>
      )}

      <div className={styles.identityGrid} aria-busy={loading}>
        <div className={styles.fields}>
          <label>
            <span>Club Tag Line</span>
            <input
              value={identity.tagline}
              aria-label="Club Tag Line"
              maxLength={CLUB_MESSAGE_LIMITS.tagline}
              onChange={(event) => setIdentity({ ...identity, tagline: event.target.value })}
              placeholder="Short Identity Line Shown With The Club"
              disabled={loading || Boolean(loadError)}
              aria-describedby="club-tagline-count"
            />
            <CharacterCount
              id="club-tagline-count"
              value={identity.tagline}
              limit={CLUB_MESSAGE_LIMITS.tagline}
            />
          </label>
          <label>
            <span>Lobby Owner Message</span>
            <input
              value={identity.lobbyMessage}
              aria-label="Lobby Owner Message"
              maxLength={CLUB_MESSAGE_LIMITS.lobbyMessage}
              onChange={(event) => setIdentity({ ...identity, lobbyMessage: event.target.value })}
              placeholder="One-Line Message Above The Club Game Lobby"
              disabled={loading || Boolean(loadError)}
              aria-describedby="club-lobby-message-count"
            />
            <CharacterCount
              id="club-lobby-message-count"
              value={identity.lobbyMessage}
              limit={CLUB_MESSAGE_LIMITS.lobbyMessage}
            />
          </label>
          <label className={styles.wideField}>
            <span>Club Description</span>
            <textarea
              rows={4}
              aria-label="Club Description"
              value={identity.description}
              maxLength={CLUB_MESSAGE_LIMITS.description}
              onChange={(event) => setIdentity({ ...identity, description: event.target.value })}
              placeholder="Long-Form Description Used On Club Information Surfaces"
              disabled={loading || Boolean(loadError)}
              aria-describedby="club-description-count"
            />
            <CharacterCount
              id="club-description-count"
              value={identity.description}
              limit={CLUB_MESSAGE_LIMITS.description}
            />
          </label>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void saveIdentity()}
            disabled={
              loading ||
              savingIdentity ||
              Boolean(loadError) ||
              identityRevision === null ||
              !identityDirty
            }
          >
            {savingIdentity ? 'Saving…' : 'Save Club Messages'}
          </button>
        </div>

        <aside className={styles.preview}>
          <span>Live Copy Preview</span>
          <h3>{identity.tagline || `Welcome To ${clubName}`}</h3>
          <strong>{identity.lobbyMessage || 'No Lobby Owner Message'}</strong>
          <p>{identity.description || 'No Long-Form Club Description'}</p>
        </aside>
      </div>

      <div className={styles.announcementSection}>
        <div className={styles.composer}>
          <div className={styles.composerHeading}>
            <div>
              <span>Announcement Banners</span>
              <h3>{editingId ? 'Edit Announcement' : 'Publish An Announcement'}</h3>
            </div>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setEditingRevision(0);
                  setDraft(EMPTY_ANNOUNCEMENT);
                }}
              >
                Cancel Edit
              </button>
            )}
          </div>
          <label>
            Title
            <input
              value={draft.title}
              aria-label="Announcement Title"
              maxLength={CLUB_MESSAGE_LIMITS.announcementTitle}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              disabled={loading || Boolean(loadError)}
              aria-describedby="announcement-title-count"
            />
            <CharacterCount
              id="announcement-title-count"
              value={draft.title}
              limit={CLUB_MESSAGE_LIMITS.announcementTitle}
            />
          </label>
          <label>
            Message
            <textarea
              rows={5}
              aria-label="Announcement Message"
              value={draft.content}
              maxLength={CLUB_MESSAGE_LIMITS.announcementContent}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              disabled={loading || Boolean(loadError)}
              aria-describedby="announcement-content-count"
            />
            <CharacterCount
              id="announcement-content-count"
              value={draft.content}
              limit={CLUB_MESSAGE_LIMITS.announcementContent}
            />
          </label>
          <div className={styles.composerOptions}>
            <label>
              <input
                type="checkbox"
                checked={draft.isPinned}
                onChange={(event) => setDraft({ ...draft, isPinned: event.target.checked })}
                disabled={loading || Boolean(loadError)}
              />
              Pin Banner
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
                disabled={loading || Boolean(loadError)}
              />
              Display Now
            </label>
            <button
              type="button"
              className={styles.primary}
              disabled={
                !draft.title.trim() ||
                !draft.content.trim() ||
                Boolean(loadError) ||
                identityRevision === null ||
                busyAnnouncement === (editingId || 'new')
              }
              onClick={() => void saveAnnouncement()}
            >
              {busyAnnouncement === (editingId || 'new')
                ? 'Saving…'
                : editingId
                  ? 'Update Announcement'
                  : 'Publish Announcement'}
            </button>
          </div>
        </div>

        <div className={styles.announcementList}>
          <h3>Current Announcements</h3>
          {loading ? (
            <p>Loading Messages…</p>
          ) : announcements.length === 0 ? (
            <p>No Announcements Have Been Published.</p>
          ) : (
            announcements.map((announcement) => (
              <article
                key={announcement.id}
                className={!announcement.isActive ? styles.inactive : ''}
              >
                <div>
                  <span>
                    {announcement.isPinned ? 'Pinned' : 'Standard'} ·{' '}
                    {announcement.isActive ? 'Displayed' : 'Hidden'}
                  </span>
                  <h4>{announcement.title}</h4>
                  <p>{announcement.content}</p>
                </div>
                <div className={styles.announcementActions}>
                  <button
                    type="button"
                    disabled={busyAnnouncement === announcement.id}
                    onClick={() => {
                      setEditingId(announcement.id);
                      setEditingRevision(announcement.revision);
                      setDraft({
                        title: announcement.title,
                        content: announcement.content,
                        isPinned: announcement.isPinned,
                        isActive: announcement.isActive,
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyAnnouncement === announcement.id}
                    onClick={() =>
                      void mutateAnnouncement(announcement, 'set_pin', !announcement.isPinned)
                    }
                  >
                    {announcement.isPinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    disabled={busyAnnouncement === announcement.id}
                    onClick={() =>
                      void mutateAnnouncement(announcement, 'set_active', !announcement.isActive)
                    }
                  >
                    {announcement.isActive ? 'Hide' : 'Display'}
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busyAnnouncement === announcement.id}
                    onClick={() => void mutateAnnouncement(announcement, 'delete')}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
      <p className={styles.saveStatus} role="status" aria-live="polite">
        {dirty ? 'Unsaved Message Changes Are Staged Locally.' : 'All Message Changes Are Saved.'}
      </p>
    </section>
  );
}
