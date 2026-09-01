import { useCallback, useEffect, useState } from 'react';
import {
  CLUB_MESSAGE_LIMITS,
  clubMessageManagementService,
  type ClubIdentityMessages,
  type ManagedClubAnnouncement,
} from '../../services/ClubMessageManagementService';
import { confirmDialog } from '../common/confirmDialog';
import { useToast } from '../common/Toast';
import styles from './ClubMessageManagementPanel.module.css';

const EMPTY_IDENTITY: ClubIdentityMessages = { tagline: '', lobbyMessage: '', description: '' };
const EMPTY_ANNOUNCEMENT = { title: '', content: '', isPinned: false, isActive: true };

function CharacterCount({ value, limit }: { value: string; limit: number }) {
  return (
    <small className={value.length === limit ? styles.atLimit : ''}>
      {value.length}/{limit}
    </small>
  );
}

export default function ClubMessageManagementPanel({
  clubId,
  clubName,
}: {
  clubId: string;
  clubName: string;
}) {
  const toast = useToast();
  const [identity, setIdentity] = useState<ClubIdentityMessages>(EMPTY_IDENTITY);
  const [announcements, setAnnouncements] = useState<ManagedClubAnnouncement[]>([]);
  const [draft, setDraft] = useState(EMPTY_ANNOUNCEMENT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [busyAnnouncement, setBusyAnnouncement] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await clubMessageManagementService.get(clubId);
      setIdentity(value.identity);
      setAnnouncements(value.announcements);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load club messages.');
    } finally {
      setLoading(false);
    }
  }, [clubId, toast]);

  useEffect(() => {
    setIdentity(EMPTY_IDENTITY);
    setDraft(EMPTY_ANNOUNCEMENT);
    setEditingId(null);
    void load();
  }, [load]);

  const saveIdentity = async () => {
    setSavingIdentity(true);
    try {
      await clubMessageManagementService.saveIdentity(clubId, identity);
      toast.success('Club messages saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save club messages.');
    } finally {
      setSavingIdentity(false);
    }
  };

  const saveAnnouncement = async () => {
    setBusyAnnouncement(editingId || 'new');
    try {
      await clubMessageManagementService.manageAnnouncement(clubId, 'save', {
        id: editingId || undefined,
        ...draft,
      });
      toast.success(editingId ? 'Announcement updated.' : 'Announcement published.');
      setDraft(EMPTY_ANNOUNCEMENT);
      setEditingId(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the announcement.');
    } finally {
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
    try {
      await clubMessageManagementService.manageAnnouncement(clubId, action, {
        ...announcement,
        isPinned: action === 'set_pin' ? value : announcement.isPinned,
        isActive: action === 'set_active' ? value : announcement.isActive,
      });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the announcement.');
    } finally {
      setBusyAnnouncement(null);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="club-message-management-title">
      <header className={styles.heading}>
        <div>
          <span>Club Message Management</span>
          <h2 id="club-message-management-title">Every Player-Facing Club Message</h2>
          <p>{clubName} · Edit identity copy and announcement banners from one governed surface.</p>
        </div>
        <span className={styles.limitKey}>Limits Are Enforced In The Database</span>
      </header>

      <div className={styles.identityGrid} aria-busy={loading}>
        <div className={styles.fields}>
          <label>
            <span>Club Tag Line</span>
            <input
              value={identity.tagline}
              maxLength={CLUB_MESSAGE_LIMITS.tagline}
              onChange={(event) => setIdentity({ ...identity, tagline: event.target.value })}
              placeholder="Short identity line shown with the club"
              disabled={loading}
            />
            <CharacterCount value={identity.tagline} limit={CLUB_MESSAGE_LIMITS.tagline} />
          </label>
          <label>
            <span>Lobby Owner Message</span>
            <input
              value={identity.lobbyMessage}
              maxLength={CLUB_MESSAGE_LIMITS.lobbyMessage}
              onChange={(event) => setIdentity({ ...identity, lobbyMessage: event.target.value })}
              placeholder="One-line message above the club game lobby"
              disabled={loading}
            />
            <CharacterCount
              value={identity.lobbyMessage}
              limit={CLUB_MESSAGE_LIMITS.lobbyMessage}
            />
          </label>
          <label className={styles.wideField}>
            <span>Club Description</span>
            <textarea
              rows={4}
              value={identity.description}
              maxLength={CLUB_MESSAGE_LIMITS.description}
              onChange={(event) => setIdentity({ ...identity, description: event.target.value })}
              placeholder="Long-form description used on club information surfaces"
              disabled={loading}
            />
            <CharacterCount value={identity.description} limit={CLUB_MESSAGE_LIMITS.description} />
          </label>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void saveIdentity()}
            disabled={loading || savingIdentity}
          >
            {savingIdentity ? 'Saving…' : 'Save Club Messages'}
          </button>
        </div>

        <aside className={styles.preview}>
          <span>Live Copy Preview</span>
          <h3>{identity.tagline || `Welcome To ${clubName}`}</h3>
          <strong>{identity.lobbyMessage || 'No lobby owner message'}</strong>
          <p>{identity.description || 'No long-form club description'}</p>
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
              maxLength={CLUB_MESSAGE_LIMITS.announcementTitle}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            <CharacterCount value={draft.title} limit={CLUB_MESSAGE_LIMITS.announcementTitle} />
          </label>
          <label>
            Message
            <textarea
              rows={5}
              value={draft.content}
              maxLength={CLUB_MESSAGE_LIMITS.announcementContent}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            />
            <CharacterCount value={draft.content} limit={CLUB_MESSAGE_LIMITS.announcementContent} />
          </label>
          <div className={styles.composerOptions}>
            <label>
              <input
                type="checkbox"
                checked={draft.isPinned}
                onChange={(event) => setDraft({ ...draft, isPinned: event.target.checked })}
              />
              Pin Banner
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
              />
              Display Now
            </label>
            <button
              type="button"
              className={styles.primary}
              disabled={
                !draft.title.trim() ||
                !draft.content.trim() ||
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
            <p>Loading messages…</p>
          ) : announcements.length === 0 ? (
            <p>No announcements have been published.</p>
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
    </section>
  );
}
