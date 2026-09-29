/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER NOTES PANEL — In-Game Note Taking
 * Take and view notes on opponents during gameplay
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { useAuthUser } from '../../hooks/useAuthUser';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { NOTE_COLORS, PLAYER_TAGS } from '../../services/PlayerNotesService';
import { showDiamondTopUp } from '../common/DiamondTopUpToast';
import { useToast } from '../common/Toast';
import styles from './PlayerNotesPanel.module.css';
import { SpadeConsole } from '../console/SpadeConsole';
import { reportError } from '../../utils/errorReporter';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../../utils/playerDisplayName';

interface PlayerNote {
  id: string;
  targetUserId: string;
  targetName: string;
  targetAvatar?: string;
  note: string;
  tags: string[];
  color: string;
  lastUpdated: string;
}

interface PlayerNotesPanelProps {
  targetUserId?: string;
  targetName?: string;
  targetAvatar?: string;
  onClose?: () => void;
  compact?: boolean;
}

// Use canonical constants from PlayerNotesService
const PRESET_TAGS = PLAYER_TAGS;

export default function PlayerNotesPanel({
  targetUserId,
  targetName,
  targetAvatar,
  onClose,
  compact = false,
}: PlayerNotesPanelProps) {
  const { user } = useAuthUser();
  const [notes, setNotes] = useState<PlayerNote[]>([]);
  const [currentNote, setCurrentNote] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState('none');
  const [loading, setLoading] = useState(true);
  /* When the existing note could not be read, saving would overwrite a note
     the player cannot see. The save button refuses until a reload succeeds. */
  const [noteLoadFailed, setNoteLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  /** In-flight latch for the paid tag purchase — see toggleTag. */
  const tagPurchaseRef = useRef(false);
  const accountRequestRef = useRef(0);
  const tagPurchaseRequestRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [isVIP, setIsVIP] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { style: staggerStyle } = useStaggerAnimation(notes.length);
  const activeScope = `${user?.id || 'anonymous'}:${targetUserId || 'library'}`;
  const activeScopeRef = useRef(activeScope);
  const [stateScope, setStateScope] = useState(activeScope);

  // Auth and target changes can replace this panel without unmounting it.
  // Move the authority ref during render so late continuations are stale even
  // before passive-effect cleanup runs.
  if (activeScopeRef.current !== activeScope) {
    activeScopeRef.current = activeScope;
    accountRequestRef.current += 1;
    tagPurchaseRequestRef.current += 1;
    tagPurchaseRef.current = false;
  }

  const stateBelongsToActiveScope = stateScope === activeScope;
  const visibleNotes = stateBelongsToActiveScope ? notes : [];
  const visibleCurrentNote = stateBelongsToActiveScope ? currentNote : '';
  const visibleSelectedTags = stateBelongsToActiveScope ? selectedTags : [];
  const visibleSelectedColor = stateBelongsToActiveScope ? selectedColor : 'none';
  const visibleIsVIP = stateBelongsToActiveScope && isVIP;
  const visibleLoading = !stateBelongsToActiveScope || loading;
  const visibleLoadFailed = stateBelongsToActiveScope && noteLoadFailed;

  useEffect(() => {
    let mounted = true;
    const requestedUserId = user?.id;
    const requestedTargetUserId = targetUserId;
    const requestedScope = activeScope;
    const requestId = ++accountRequestRef.current;
    const isCurrent = () =>
      mounted &&
      activeScopeRef.current === requestedScope &&
      accountRequestRef.current === requestId;

    setStateScope(requestedScope);
    setNotes([]);
    setCurrentNote('');
    setSelectedTags([]);
    setSelectedColor('none');
    setSearchQuery('');
    setIsVIP(false);
    setSaving(false);
    setNoteLoadFailed(false);
    setLoading(!!requestedUserId);
    tagPurchaseRef.current = false;

    if (!requestedUserId) {
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    const loadSingleNote = async () => {
      const { data, error } = await supabase
        .from('player_notes')
        .select('id, user_id, target_user_id, notes, color_label, tags')
        .eq('user_id', requestedUserId)
        .eq('target_user_id', requestedTargetUserId)
        .maybeSingle();

      if (!isCurrent()) return;
      if (error) {
        reportError(error, 'PlayerNotesPanel.loadSingleNote');
        setNoteLoadFailed(true);
        setLoading(false);
        toast.error('Your Note On This Player Could Not Be Loaded');
        return;
      }
      if (data) {
        setCurrentNote(data.notes || '');
        setSelectedTags(data.tags || []);
        setSelectedColor(data.color_label || 'none');
      }
      setLoading(false);
    };

    const loadAllNotes = async () => {
      const { data, error } = await supabase
        .from('player_notes')
        .select('id, target_user_id, notes, tags, color_label, updated_at')
        .eq('user_id', requestedUserId)
        .order('updated_at', { ascending: false });

      if (!isCurrent()) return;
      if (error) {
        reportError(error, 'PlayerNotesPanel.loadAllNotes');
        setNoteLoadFailed(true);
        setLoading(false);
        return;
      }
      if (data) {
        const tIds = [...new Set(data.map((n: any) => n.target_user_id).filter(Boolean))];
        const pMap: Record<string, NameableProfile & { avatar_url?: string }> = {};
        if (tIds.length > 0) {
          try {
            const { data: profs } = await supabase
              .from('profiles')
              .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
              .in('id', tIds);
            if (!isCurrent()) return;
            if (profs) for (const p of profs) pMap[p.id] = p;
          } catch (error) {
            if (!isCurrent()) return;
            reportError(error, 'PlayerNotesPanel.Set');
          }
        }
        const mapped: PlayerNote[] = data.map((note: any) => ({
          id: note.id,
          targetUserId: note.target_user_id,
          targetName: playerDisplayName(pMap[note.target_user_id]),
          targetAvatar: pMap[note.target_user_id]?.avatar_url,
          note: note.notes,
          tags: note.tags || [],
          color: note.color_label || '#6b7280',
          lastUpdated: note.updated_at,
        }));
        if (isCurrent()) setNotes(mapped);
      }
      if (isCurrent()) setLoading(false);
    };

    void (requestedTargetUserId ? loadSingleNote() : loadAllNotes());
    void vipService
      .checkVIPStatus(requestedUserId)
      .then((status) => {
        if (isCurrent()) setIsVIP(status.isVIP);
      })
      .catch((error) => {
        if (isCurrent()) {
          console.warn('[PlayerNotesPanel] Failed To Check VIP Status:', error);
        }
      });

    return () => {
      mounted = false;
      if (accountRequestRef.current === requestId) accountRequestRef.current += 1;
    };
  }, [activeScope, targetUserId, toast, user?.id]);

  const saveNote = async () => {
    const requestedUserId = user?.id;
    const requestedScope = activeScope;
    const note = visibleCurrentNote.trim();
    if (!requestedUserId || !targetUserId || !note || !stateBelongsToActiveScope || visibleLoading)
      return;
    if (visibleLoadFailed) {
      toast.error('Your Existing Note Could Not Be Read. Reopen The Panel Before Saving.');
      return;
    }
    const requestId = ++accountRequestRef.current;
    const isCurrent = () =>
      activeScopeRef.current === requestedScope && accountRequestRef.current === requestId;
    setSaving(true);

    const { error } = await supabase.from('player_notes').upsert(
      {
        user_id: requestedUserId,
        target_user_id: targetUserId,
        notes: note,
        tags: visibleSelectedTags,
        color_label: visibleSelectedColor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,target_user_id' }
    );

    if (!isCurrent()) return;
    setSaving(false);
    if (error) {
      toast.error('Failed To Save Note');
      return;
    }
    onClose?.();
  };

  const toggleTag = async (tag: string) => {
    if (!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed) return;
    // Removing a tag is always free
    if (visibleSelectedTags.includes(tag)) {
      setSelectedTags((prev) => prev.filter((t) => t !== tag));
      return;
    }

    /**
     * AUDIT 2026-08-28 — A NON-VIP COULD ADD EXACTLY ONE TAG, EVER.
     *
     * `tag_pack` is priced `permanent` (VIPService FEATURE_PRICING even notes
     * it is "advertised per_use, actually written permanent"), so after the
     * first successful purchase fn_purchase_feature answers `already_owned`
     * with `success: false`. This site checked only `success`, so every
     * subsequent tag opened the buy-more-diamonds sheet for something the
     * player already owned, and `setSelectedTags` was never reached.
     * Ownership is permission. Also given an in-flight ref, because two taps
     * inside one commit both passed the `includes` test above (state had not
     * committed) and both charged.
     */
    if (!visibleIsVIP) {
      const requestedUserId = user?.id;
      const requestedScope = activeScope;
      if (!requestedUserId) return;
      if (tagPurchaseRef.current) return;
      tagPurchaseRef.current = true;
      const requestId = ++tagPurchaseRequestRef.current;
      const isCurrent = () =>
        activeScopeRef.current === requestedScope && tagPurchaseRequestRef.current === requestId;
      try {
        const result = await vipService.purchaseFeature(requestedUserId, 'tag_pack');
        if (!isCurrent()) return;
        if (!result.success && !result.alreadyOwned) {
          showDiamondTopUp(toast, navigate, {
            feature: 'Player Tag',
            cost: FEATURE_PRICING.tag_pack.cost,
          });
          return;
        }
      } finally {
        if (isCurrent()) tagPurchaseRef.current = false;
      }
    }

    if (activeScopeRef.current !== activeScope) return;
    setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  };

  const deleteNote = async (noteId: string) => {
    const requestedUserId = user?.id;
    const requestedScope = activeScope;
    if (!requestedUserId || !stateBelongsToActiveScope) return;
    const requestId = ++accountRequestRef.current;
    // SECURITY: Scope to current user to prevent deleting other users' notes
    const { error } = await supabase
      .from('player_notes')
      .delete()
      .eq('id', noteId)
      .eq('user_id', requestedUserId);
    if (activeScopeRef.current !== requestedScope || accountRequestRef.current !== requestId)
      return;
    if (error) {
      toast.error('Failed To Delete Note');
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  };

  const filteredNotes = visibleNotes.filter(
    (n) =>
      n.targetName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.note.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Single note editor mode
  if (targetUserId) {
    const saveLabel = saving ? 'Saving...' : 'Save Note';
    const saveDisabled =
      saving ||
      visibleLoading ||
      visibleLoadFailed ||
      !visibleCurrentNote.trim() ||
      !stateBelongsToActiveScope;
    const body = (
      <>
        <label className={styles.srOnly} htmlFor="player-note-input">
          Notes About This Player
        </label>
        <textarea
          id="player-note-input"
          className={styles.noteInput}
          placeholder="Add Notes About This Player..."
          value={visibleCurrentNote}
          onChange={(e) => setCurrentNote(e.target.value)}
          rows={compact ? 3 : 5}
          disabled={visibleLoading || visibleLoadFailed}
        />

        {visibleLoadFailed && (
          <div className={`${styles.empty} sc-ink--red`} role="alert">
            Player Note Could Not Be Loaded. Close And Try Again.
          </div>
        )}

        <div className={styles.section}>
          <span className={`${styles.sectionTitle} sc-label sc-ink--blue`}>Tags</span>
          <div className={styles.tags} role="group" aria-label="Player Tags">
            {PRESET_TAGS.map((tag) => {
              const on = visibleSelectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`${styles.word} ${styles.tag} ${on ? `${styles.selected} sc-ink--white` : 'sc-ink--muted'}`}
                  aria-pressed={on}
                  onClick={() => toggleTag(tag)}
                  disabled={!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.section}>
          <span className={`${styles.sectionTitle} sc-label sc-ink--blue`}>Color Label</span>
          <div className={styles.colors} role="group" aria-label="Note Color">
            {NOTE_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className={`${styles.colorBtn} ${visibleSelectedColor === color.value ? styles.selected : ''}`}
                style={{ backgroundColor: color.hex }}
                onClick={() => setSelectedColor(color.value)}
                title={color.name}
                aria-label={color.name}
                aria-pressed={visibleSelectedColor === color.value}
                disabled={!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed}
              />
            ))}
          </div>
        </div>
      </>
    );
    /* TWO ACTIONS OR NONE on the painted plates: with a caller to hand the
       panel back to, Cancel and Save Note take the two plates; without one
       the foot closes flat and Save Note is a lit word on the glass. */
    if (onClose) {
      return (
        <SpadeConsole
          onClose={onClose}
          className={`${styles.console} ${compact ? styles.compact : ''}`}
          eyebrow="Player Notes"
          title={targetName || 'Player'}
          pill={visibleLoading ? 'Reading' : visibleLoadFailed ? 'Unread' : 'Note'}
          pillInk={visibleLoadFailed ? 'red' : 'blue'}
          plates={{
            secondary: { label: 'Cancel', onClick: onClose },
            primary: { label: saveLabel, ink: 'white', onClick: saveNote, disabled: saveDisabled },
          }}
        >
          {body}
        </SpadeConsole>
      );
    }
    return (
      <SpadeConsole
        onClose={onClose}
        className={`${styles.console} ${compact ? styles.compact : ''}`}
        eyebrow="Player Notes"
        title={targetName || 'Player'}
        pill={visibleLoading ? 'Reading' : visibleLoadFailed ? 'Unread' : 'Note'}
        pillInk={visibleLoadFailed ? 'red' : 'blue'}
        foot="foot"
      >
        {body}
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.word} ${styles.saveBtn} sc-ink--white`}
            onClick={saveNote}
            disabled={saveDisabled}
          >
            {saveLabel}
          </button>
        </div>
      </SpadeConsole>
    );
  }

  // Notes library mode
  const library = (
    <>
      <label className={styles.srOnly} htmlFor="player-notes-search">
        Search Notes
      </label>
      <input
        id="player-notes-search"
        type="text"
        className={styles.searchInput}
        placeholder="Search Notes..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        disabled={visibleLoading || visibleLoadFailed}
      />

      <div className={styles.notesList}>
        {visibleLoading ? (
          <div className={`${styles.empty} sc-ink--muted`}>Loading Notes...</div>
        ) : visibleLoadFailed ? (
          <div className={`${styles.empty} sc-ink--red`} role="alert">
            Player Notes Could Not Be Loaded. Close And Try Again.
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className={`${styles.empty} sc-ink--muted`}>
            {searchQuery ? 'No Matching Notes' : 'No Notes Yet'}
          </div>
        ) : (
          filteredNotes.map((note, idx) => (
            <div key={note.id} className={styles.noteCard} style={staggerStyle(idx)}>
              <div className={styles.noteHeader}>
                <div className={styles.targetInfo}>
                  <span
                    className={styles.swatch}
                    style={{ backgroundColor: note.color }}
                    aria-hidden="true"
                  />
                  <div className={styles.avatar}>
                    {note.targetAvatar ? (
                      <img loading="lazy" decoding="async" src={note.targetAvatar} alt="" />
                    ) : (
                      ''
                    )}
                  </div>
                  <span className={`${styles.targetName} sc-ink--silver`}>{note.targetName}</span>
                </div>
                <span className={`${styles.noteDate} sc-ink--muted`}>
                  {formatDate(note.lastUpdated)}
                </span>
              </div>
              <p className={`${styles.noteText} sc-copy`}>{note.note}</p>
              <div className={styles.noteFoot}>
                {note.tags.length > 0 && (
                  <div className={styles.noteTags}>
                    {note.tags.map((tag) => (
                      <span key={tag} className={`${styles.noteTag} sc-ink--blue`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className={`${styles.word} ${styles.deleteBtn} sc-ink--red`}
                  onClick={() => deleteNote(note.id)}
                  aria-label={`Delete Note On ${note.targetName}`}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
  if (onClose) {
    return (
      <SpadeConsole
        onClose={onClose}
        className={styles.console}
        eyebrow="Player Notes"
        title="Notes Library"
        pill={loading ? 'Reading' : `${notes.length.toLocaleString()} Notes`}
        foot="foot"
      >
        {library}
        <div className={styles.actions}>
          <button type="button" className={`${styles.word} sc-ink--white`} onClick={onClose}>
            Close
          </button>
        </div>
      </SpadeConsole>
    );
  }
  return (
    <SpadeConsole
      onClose={onClose}
      className={styles.console}
      eyebrow="Player Notes"
      title="Notes Library"
      pill={loading ? 'Reading' : `${notes.length.toLocaleString()} Notes`}
      foot="foot"
    >
      {library}
    </SpadeConsole>
  );
}
