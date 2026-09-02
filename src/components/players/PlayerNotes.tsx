/**
 * ♠ CLUB ARENA — Player Notes
 * Personal notes system for tracking opponents
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useStaggerAnimation } from '../../hooks/useStaggerAnimation';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { NOTE_COLORS, PLAYER_TAGS } from '../../services/PlayerNotesService';
import { useToast } from '../common/Toast';
import './PlayerNotes.css';
import { reportError } from '../../utils/errorReporter';

interface PlayerNote {
  id: string;
  playerId: string;
  playerName: string;
  playerAvatar?: string;
  noteColor: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
  note: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface PlayerNotesProps {
  playerId?: string;
  onClose?: () => void;
  mode?: 'view' | 'edit' | 'list';
}

export const PlayerNotes: React.FC<PlayerNotesProps> = ({ playerId, onClose, mode = 'list' }) => {
  const { user } = useAuthUser();
  const toast = useToast();
  const [notes, setNotes] = useState<PlayerNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<PlayerNote | null>(null);
  const [editingNote, setEditingNote] = useState('');
  const [selectedColor, setSelectedColor] = useState<PlayerNote['noteColor']>('green');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const { style: staggerStyle } = useStaggerAnimation(notes.length);

  // Use canonical color/tag constants from PlayerNotesService
  const colors = NOTE_COLORS.filter((c) => c.id !== 'none').map((c) => ({
    id: c.id as PlayerNote['noteColor'],
    label: c.name,
  }));

  const commonTags = PLAYER_TAGS;

  useEffect(() => {
    loadNotes();
  }, [user?.id, playerId]);

  const loadNotes = async () => {
    if (!user?.id) return;

    try {
      let query = supabase
        .from('player_notes')
        .select('id, user_id, target_user_id, notes, color_label, tags, updated_at, created_at')
        .eq('user_id', user.id);

      if (playerId) {
        query = query.eq('target_user_id', playerId);
      }

      const { data, error } = await query.order('updated_at', { ascending: false });

      if (error) throw error;
      if (!isMounted.current) return;

      // Replaced fallback mock data
      setNotes(
        (data || []).map((d: any) => ({
          id: d.id,
          playerId: d.target_user_id,
          playerName: '',
          noteColor: d.color_label || 'blue',
          note: d.notes || '',
          tags: d.tags || [],
          createdAt: d.created_at,
          updatedAt: d.updated_at,
        }))
      );
    } catch (error) {
      reportError(error, 'PlayerNotes.Failed_to_load_notes');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const saveNote = async () => {
    if (!user?.id || !playerId || !editingNote.trim()) return;

    try {
      const noteData = {
        user_id: user.id,
        target_user_id: playerId,
        color_label: selectedColor,
        notes: editingNote,
        tags: selectedTags,
      };

      const { error } = await supabase
        .from('player_notes')
        .upsert(noteData, { onConflict: 'user_id,target_user_id' });

      if (error) throw error;

      toast.success('Note saved!');
      loadNotes();
      setEditingNote('');
      setSelectedTags([]);
    } catch (error) {
      reportError(error, 'PlayerNotes.Failed_to_save_note');
      toast.error('Failed to save note');
    }
  };

  const deleteNote = async (noteId: string) => {
    try {
      // SECURITY: Scope to current user to prevent deleting other users' notes
      const { error } = await supabase
        .from('player_notes')
        .delete()
        .eq('id', noteId)
        .eq('user_id', user?.id || '');

      if (error) throw error;

      toast.success('Note deleted');
      loadNotes();
    } catch (error) {
      reportError(error, 'PlayerNotes.Failed_to_delete_note');
      toast.error('Failed to delete note');
    }
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const filteredNotes = notes.filter(
    (n) =>
      n.playerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.note.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (loading) {
    return (
      <div className="player-notes loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="player-notes">
      <div className="notes-header">
        <h2>Player Notes</h2>
        {onClose && (
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      {/* Search */}
      <div className="notes-search">
        <input
          type="text"
          placeholder="Search Notes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Color Legend */}
      <div className="color-legend">
        {colors.map((c) => (
          <span key={c.id} className={`legend-item color-${c.id}`}>
            ● {c.label}
          </span>
        ))}
      </div>

      {/* Notes List */}
      <div className="notes-list">
        {filteredNotes.length === 0 ? (
          <div className="empty-notes">
            <span>▤</span>
            <p>No Notes Yet</p>
          </div>
        ) : (
          filteredNotes.map((note, i) => (
            <div
              key={note.id}
              className={`note-card color-${note.noteColor}`}
              onClick={() => setSelectedNote(note)}
              style={staggerStyle(i)}
            >
              <div className="note-header">
                <div className="player-info">
                  <span className={`color-dot color-${note.noteColor}`}>●</span>
                  <span className="player-name">{note.playerName}</span>
                </div>
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNote(note.id);
                  }}
                >
                  ✕
                </button>
              </div>
              <p className="note-text">{note.note}</p>
              <div className="note-tags">
                {note.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Edit Panel (if playerId provided) */}
      {playerId && (
        <div className="edit-panel">
          <h4>Add/Edit Note</h4>

          {/* Color Selector */}
          <div className="color-selector">
            {colors.map((c) => (
              <button
                key={c.id}
                className={`color-btn color-${c.id} ${selectedColor === c.id ? 'active' : ''}`}
                onClick={() => setSelectedColor(c.id)}
                title={c.label}
              />
            ))}
          </div>

          {/* Note Input */}
          <textarea
            value={editingNote}
            onChange={(e) => setEditingNote(e.target.value)}
            placeholder="Write Your Notes About This Player..."
            maxLength={500}
          />

          {/* Tags */}
          <div className="tag-selector">
            {commonTags.map((tag) => (
              <button
                key={tag}
                className={`tag-btn ${selectedTags.includes(tag) ? 'active' : ''}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>

          <button className="save-btn" onClick={saveNote}>
            Save Note
          </button>
        </div>
      )}
    </div>
  );
};

export default PlayerNotes;
