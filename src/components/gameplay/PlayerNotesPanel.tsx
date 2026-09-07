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
  const [loadFailed, setLoadFailed] = useState(false);
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

  // Auth and target changes can replace the panel without unmounting it. Refs
  // move with the render, before passive-effect cleanup, so no late status,
  // note, or paid-tag continuation from account A can paint account B.
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
  const visibleLoadFailed = stateBelongsToActiveScope && loadFailed;

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
    setLoadFailed(false);
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
      /* A FAILED READ IS NOT "NO NOTE ON THIS PLAYER" (2026-08-29). Only `data`
         was destructured, and a Supabase builder resolves with {data: null,
         error} rather than rejecting, so a failure left the panel showing an
         empty note and invited an overwrite of an existing note. */
      if (error) {
        reportError(error, 'PlayerNotesPanel.loadSingleNote');
        setLoadFailed(true);
        setLoading(false);
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
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      if (data) {
        // Batch-fetch target profiles separately (safe, no FK hint)
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
          } catch (e) {
            if (!isCurrent()) return;
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
        if (isCurrent()) setNotes(mapped);
      }
      if (isCurrent()) setLoading(false);
    };

    void (requestedTargetUserId ? loadSingleNote() : loadAllNotes());

    // Check VIP status for tag gating. A late Lifetime answer must not grant the
    // replacement account free tags.
    void vipService
      .checkVIPStatus(requestedUserId)
      .then((status) => {
        if (isCurrent()) setIsVIP(status.isVIP);
      })
      .catch((e) => {
        if (isCurrent()) {
          console.warn('[PlayerNotesPanel] Failed To Check VIP Status:', e);
        }
      });

    return () => {
      mounted = false;
      if (accountRequestRef.current === requestId) accountRequestRef.current += 1;
    };
  }, [activeScope, targetUserId, user?.id]);

  const saveNote = async () => {
    const requestedUserId = user?.id;
    const requestedScope = activeScope;
    const note = visibleCurrentNote.trim();
    if (
      !requestedUserId ||
      !targetUserId ||
      !note ||
      !stateBelongsToActiveScope ||
      visibleLoading ||
      visibleLoadFailed
    )
      return;
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
    // Removing a tag is always free
    if (!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed) return;
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
    return (
      <div className={`${styles.panel} ${compact ? styles.compact : ''}`}>
        <div className={styles.header}>
          <div className={styles.targetInfo}>
            <div className={styles.avatar}>
              {targetAvatar ? (
                <img loading="lazy" decoding="async" src={targetAvatar} alt="" />
              ) : (
                ''
              )}
            </div>
            <span>{targetName || 'Player'}</span>
          </div>
          {onClose && (
            <button className={styles.closeBtn} onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        <textarea
          className={styles.noteInput}
          placeholder="Add Notes About This Player..."
          value={visibleCurrentNote}
          onChange={(e) => setCurrentNote(e.target.value)}
          rows={compact ? 3 : 5}
          disabled={visibleLoading || visibleLoadFailed}
        />

        {visibleLoadFailed && (
          <div className={styles.empty} role="alert">
            Player Note Could Not Be Loaded. Close And Try Again.
          </div>
        )}

        <div className={styles.tags}>
          {PRESET_TAGS.map((tag) => (
            <button
              key={tag}
              className={`${styles.tag} ${visibleSelectedTags.includes(tag) ? styles.selected : ''}`}
              onClick={() => toggleTag(tag)}
              aria-pressed={visibleSelectedTags.includes(tag)}
              disabled={!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed}
            >
              {tag}
            </button>
          ))}
        </div>

        <div className={styles.colors}>
          {NOTE_COLORS.map((color) => (
            <button
              key={color.value}
              className={`${styles.colorBtn} ${visibleSelectedColor === color.value ? styles.selected : ''}`}
              style={{ backgroundColor: color.hex }}
              onClick={() => setSelectedColor(color.value)}
              title={color.name}
              disabled={!stateBelongsToActiveScope || visibleLoading || visibleLoadFailed}
            />
          ))}
        </div>

        <button
          className={styles.saveBtn}
          onClick={saveNote}
          disabled={
            saving ||
            visibleLoading ||
            visibleLoadFailed ||
            !visibleCurrentNote.trim() ||
            !stateBelongsToActiveScope
          }
        >
          {saving ? 'Saving...' : 'Save Note'}
        </button>
      </div>
    );
  }

  // Notes library mode
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3> Player Notes</h3>
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <input
        type="text"
        className={styles.searchInput}
        placeholder="Search Notes..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        disabled={visibleLoading || visibleLoadFailed}
      />

      <div className={styles.notesList}>
        {visibleLoading ? (
          <div className={styles.loading}>Loading Notes...</div>
        ) : visibleLoadFailed ? (
          <div className={styles.empty} role="alert">
            Player Notes Could Not Be Loaded. Close And Try Again.
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className={styles.empty}>{searchQuery ? 'No Matching Notes' : 'No Notes Yet'}</div>
        ) : (
          filteredNotes.map((note, idx) => (
            <div
              key={note.id}
              className={styles.noteCard}
              style={{
                borderLeftColor: note.color,
                ...staggerStyle(idx),
              }}
            >
              <div className={styles.noteHeader}>
                <div className={styles.targetInfo}>
                  <div className={styles.avatar}>
                    {note.targetAvatar ? (
                      <img loading="lazy" decoding="async" src={note.targetAvatar} alt="" />
                    ) : (
                      ''
                    )}
                  </div>
                  <span>{note.targetName}</span>
                </div>
                <span className={styles.noteDate}>{formatDate(note.lastUpdated)}</span>
              </div>
              <p className={styles.noteText}>{note.note}</p>
              {note.tags.length > 0 && (
                <div className={styles.noteTags}>
                  {note.tags.map((tag) => (
                    <span key={tag} className={styles.noteTag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <button className={styles.deleteBtn} onClick={() => deleteNote(note.id)}>
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
