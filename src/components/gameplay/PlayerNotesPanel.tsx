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
  const [searchQuery, setSearchQuery] = useState('');
  const [isVIP, setIsVIP] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  const { style: staggerStyle } = useStaggerAnimation(notes.length);

  useEffect(() => {
    if (!user?.id) return undefined;
    /* THE NOTE ON SCREEN IS THE NOTE ON THIS PLAYER (2026-09-10). The load
       wrote state only inside `if (data)`, so switching to a player with no
       saved note kept the PREVIOUS player's text, tags and colour on screen -
       and saveNote then upserted them against the new target_user_id. The
       form is reset the moment the target changes, and a read that resolves
       after the target has moved on is dropped. */
    let cancelled = false;
    if (targetUserId) {
      loadSingleNote(() => cancelled);
    } else {
      loadAllNotes();
    }
    // Check VIP status for tag gating
    vipService
      .checkVIPStatus(user.id)
      .then((status) => {
        if (!cancelled) setIsVIP(status.isVIP);
      })
      .catch((e) => console.warn('[PlayerNotesPanel] Failed to check VIP status:', e));
    return () => {
      cancelled = true;
    };
  }, [user?.id, targetUserId]);

  const loadSingleNote = async (isCancelled: () => boolean) => {
    setLoading(true);
    setNoteLoadFailed(false);
    setCurrentNote('');
    setSelectedTags([]);
    setSelectedColor('none');
    const { data, error } = await supabase
      .from('player_notes')
      .select('id, user_id, target_user_id, notes, color_label, tags')
      .eq('user_id', user?.id)
      .eq('target_user_id', targetUserId)
      .maybeSingle();
    if (isCancelled()) return;

    /* A FAILED READ IS NOT "NO NOTE ON THIS PLAYER" (2026-08-29). Only `data`
       was destructured, and a Supabase builder resolves with {data: null,
       error} rather than rejecting, so a failure left the panel showing an
       empty note -- and the player, believing they had never written one,
       types a fresh one over the top of the note they already had. The sibling
       loadAllNotes twenty lines below already destructures `error`. */
    if (error) {
      reportError(error, 'PlayerNotesPanel.loadSingleNote');
      setNoteLoadFailed(true);
      toast.error('Your Note On This Player Could Not Be Loaded');
    }

    if (data) {
      setCurrentNote(data.notes || '');
      setSelectedTags(data.tags || []);
      setSelectedColor(data.color_label || 'none');
    }
    setLoading(false);
  };

  const loadAllNotes = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('player_notes')
      .select('id, target_user_id, notes, tags, color_label, updated_at')
      .eq('user_id', user?.id)
      .order('updated_at', { ascending: false });

    if (!error && data) {
      // Batch-fetch target profiles separately (safe, no FK hint)
      const tIds = [...new Set(data.map((n: any) => n.target_user_id).filter(Boolean))];
      const pMap: Record<string, NameableProfile & { avatar_url?: string }> = {};
      if (tIds.length > 0) {
        try {
          const { data: profs } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
            .in('id', tIds);
          if (profs) for (const p of profs) pMap[p.id] = p;
        } catch (e) {
          reportError(e, 'PlayerNotesPanel.Set');
          /* non-critical */
        }
      }
      const mapped: PlayerNote[] = data.map((n: any) => ({
        id: n.id,
        targetUserId: n.target_user_id,
        targetName: playerDisplayName(pMap[n.target_user_id]),
        targetAvatar: pMap[n.target_user_id]?.avatar_url,
        note: n.notes,
        tags: n.tags || [],
        color: n.color_label || '#6b7280',
        lastUpdated: n.updated_at,
      }));
      setNotes(mapped);
      // Stagger entrance is now handled by useStaggerAnimation hook
    }
    setLoading(false);
  };

  const saveNote = async () => {
    if (!user?.id || !targetUserId || !currentNote.trim()) return;
    if (noteLoadFailed) {
      toast.error('Your Existing Note Could Not Be Read. Reopen The Panel Before Saving.');
      return;
    }
    setSaving(true);

    const { error } = await supabase.from('player_notes').upsert(
      {
        user_id: user.id,
        target_user_id: targetUserId,
        notes: currentNote.trim(),
        tags: selectedTags,
        color_label: selectedColor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,target_user_id' }
    );

    setSaving(false);
    if (error) {
      toast.error('Failed to save note');
      return;
    }
    onClose?.();
  };

  const toggleTag = async (tag: string) => {
    // Removing a tag is always free
    if (selectedTags.includes(tag)) {
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
    if (!isVIP) {
      if (!user?.id) return;
      if (tagPurchaseRef.current) return;
      tagPurchaseRef.current = true;
      try {
        const result = await vipService.purchaseFeature(user.id, 'tag_pack');
        if (!result.success && !result.alreadyOwned) {
          showDiamondTopUp(toast, navigate, {
            feature: 'Player Tag',
            cost: FEATURE_PRICING.tag_pack.cost,
          });
          return;
        }
      } finally {
        tagPurchaseRef.current = false;
      }
    }

    setSelectedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  };

  const deleteNote = async (noteId: string) => {
    // SECURITY: Scope to current user to prevent deleting other users' notes
    const { error } = await supabase
      .from('player_notes')
      .delete()
      .eq('id', noteId)
      .eq('user_id', user?.id || '');
    if (error) {
      toast.error('Failed to delete note');
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

  const filteredNotes = notes.filter(
    (n) =>
      n.targetName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.note.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Single note editor mode
  if (targetUserId) {
    const saveLabel = saving ? 'Saving...' : 'Save Note';
    const saveDisabled = saving || !currentNote.trim();
    const body = (
      <>
        <label className={styles.srOnly} htmlFor="player-note-input">
          Notes About This Player
        </label>
        <textarea
          id="player-note-input"
          className={styles.noteInput}
          placeholder="Add Notes About This Player..."
          value={currentNote}
          onChange={(e) => setCurrentNote(e.target.value)}
          rows={compact ? 3 : 5}
        />

        <div className={styles.section}>
          <span className={`${styles.sectionTitle} sc-label sc-ink--blue`}>Tags</span>
          <div className={styles.tags} role="group" aria-label="Player Tags">
            {PRESET_TAGS.map((tag) => {
              const on = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`${styles.word} ${styles.tag} ${on ? `${styles.selected} sc-ink--white` : 'sc-ink--muted'}`}
                  aria-pressed={on}
                  onClick={() => toggleTag(tag)}
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
                className={`${styles.colorBtn} ${selectedColor === color.value ? styles.selected : ''}`}
                style={{ backgroundColor: color.hex }}
                onClick={() => setSelectedColor(color.value)}
                title={color.name}
                aria-label={color.name}
                aria-pressed={selectedColor === color.value}
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
          className={`${styles.console} ${compact ? styles.compact : ''}`}
          eyebrow="Player Notes"
          title={targetName || 'Player'}
          pill={loading ? 'Reading' : noteLoadFailed ? 'Unread' : 'Note'}
          pillInk={noteLoadFailed ? 'red' : 'blue'}
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
        className={`${styles.console} ${compact ? styles.compact : ''}`}
        eyebrow="Player Notes"
        title={targetName || 'Player'}
        pill={loading ? 'Reading' : noteLoadFailed ? 'Unread' : 'Note'}
        pillInk={noteLoadFailed ? 'red' : 'blue'}
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
      />

      <div className={styles.notesList}>
        {loading ? (
          <div className={`${styles.empty} sc-ink--muted`}>Loading Notes...</div>
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
