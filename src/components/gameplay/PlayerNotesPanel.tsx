/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER NOTES PANEL — In-Game Note Taking
 * Take and view notes on opponents during gameplay
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { vipService, FEATURE_PRICING } from '../../services/VIPService';
import { showDiamondTopUp } from '../common/DiamondTopUpToast';
import { useToast } from '../common/Toast';
import styles from './PlayerNotesPanel.module.css';

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

const NOTE_COLORS = [
  { name: 'Default', value: '#6b7280' },
  { name: 'Green', value: '#10b981' },
  { name: 'Yellow', value: '#fbbf24' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
];

const PRESET_TAGS = [
  'Fish',
  'Shark',
  'Tight',
  'Loose',
  'Aggressive',
  'Passive',
  'Bluffs',
  'Value Heavy',
  'Tilts Easy',
  'Station',
  'Nit',
  'LAG',
];

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
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isVIP, setIsVIP] = useState(false);
  const [visibleNotes, setVisibleNotes] = useState<Set<number>>(new Set());
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    if (user?.id) {
      if (targetUserId) {
        loadSingleNote();
      } else {
        loadAllNotes();
      }
      // Check VIP status for tag gating
      vipService
        .checkVIPStatus(user.id)
        .then((status) => setIsVIP(status.isVIP))
        .catch((e) => console.warn('[PlayerNotesPanel] Failed to check VIP status:', e));
    }
  }, [user?.id, targetUserId]);

  const loadSingleNote = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('player_notes')
      .select('id, user_id, target_user_id, notes, color_label, tags')
      .eq('user_id', user?.id)
      .eq('target_user_id', targetUserId)
      .maybeSingle();

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
      const pMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
      if (tIds.length > 0) {
        try {
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, display_name, avatar_url')
            .in('id', tIds);
          if (profs) for (const p of profs) pMap[p.id] = p;
        } catch {
          /* non-critical */
        }
      }
      const mapped: PlayerNote[] = data.map((n: any) => ({
        id: n.id,
        targetUserId: n.target_user_id,
        targetName: pMap[n.target_user_id]?.display_name || 'Unknown',
        targetAvatar: pMap[n.target_user_id]?.avatar_url,
        note: n.notes,
        tags: n.tags || [],
        color: n.color_label || '#6b7280',
        lastUpdated: n.updated_at,
      }));
      setNotes(mapped);
      // Stagger entrance
      setVisibleNotes(new Set());
      mapped.forEach((_, i) => {
        setTimeout(() => setVisibleNotes((prev) => new Set(prev).add(i)), i * 50);
      });
    }
    setLoading(false);
  };

  const saveNote = async () => {
    if (!user?.id || !targetUserId || !currentNote.trim()) return;
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

    // Adding a tag: VIPs get unlimited, non-VIPs pay 1💎 per tag
    if (!isVIP) {
      if (!user?.id) return;
      const result = await vipService.purchaseFeature(user.id, 'tag_pack');
      if (!result.success) {
        showDiamondTopUp(toast, navigate, {
          feature: 'Player Tag',
          cost: FEATURE_PRICING.tag_pack.cost,
        });
        return;
      }
    }

    setSelectedTags((prev) => [...prev, tag]);
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
          placeholder="Add notes about this player..."
          value={currentNote}
          onChange={(e) => setCurrentNote(e.target.value)}
          rows={compact ? 3 : 5}
        />

        <div className={styles.tags}>
          {PRESET_TAGS.map((tag) => (
            <button
              key={tag}
              className={`${styles.tag} ${selectedTags.includes(tag) ? styles.selected : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>

        <div className={styles.colors}>
          {NOTE_COLORS.map((color) => (
            <button
              key={color.value}
              className={`${styles.colorBtn} ${selectedColor === color.value ? styles.selected : ''}`}
              style={{ backgroundColor: color.value }}
              onClick={() => setSelectedColor(color.value)}
              title={color.name}
            />
          ))}
        </div>

        <button
          className={styles.saveBtn}
          onClick={saveNote}
          disabled={saving || !currentNote.trim()}
        >
          {saving ? 'Saving...' : '💾 Save Note'}
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
        placeholder="Search notes..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      <div className={styles.notesList}>
        {loading ? (
          <div className={styles.loading}>Loading notes...</div>
        ) : filteredNotes.length === 0 ? (
          <div className={styles.empty}>{searchQuery ? 'No matching notes' : 'No notes yet'}</div>
        ) : (
          filteredNotes.map((note, idx) => (
            <div
              key={note.id}
              className={styles.noteCard}
              style={{
                borderLeftColor: note.color,
                opacity: visibleNotes.has(idx) ? 1 : 0,
                transform: visibleNotes.has(idx) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
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
