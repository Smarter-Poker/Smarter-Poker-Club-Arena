/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER NOTES SERVICE — Store Notes on Other Players
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';

export interface PlayerNote {
  note: string;
  color: string;
  tags: string[];
  handsPlayed: number;
  lastSeen: Date | null;
}

export const NOTE_COLORS = [
  { id: 'blue', hex: '#3b82f6', name: 'Blue' },
  { id: 'green', hex: '#22c55e', name: 'Green' },
  { id: 'yellow', hex: '#eab308', name: 'Yellow' },
  { id: 'orange', hex: '#f97316', name: 'Orange' },
  { id: 'red', hex: '#ef4444', name: 'Red' },
  { id: 'purple', hex: '#a855f7', name: 'Purple' },
  { id: 'pink', hex: '#ec4899', name: 'Pink' },
  { id: 'gray', hex: '#6b7280', name: 'Gray' },
];

export const PLAYER_TAGS = [
  '🐟 Fish',
  ' Shark',
  ' Gambler',
  '🧊 Tight',
  ' Aggro',
  '🐢 Passive',
  ' Whale',
  ' Tricky',
  ' Slow',
  '🏃 Fast',
  ' Improving',
  ' Tilting',
  ' Bluffer',
  ' Nit',
  '🌊 Calling Station',
];

const DEFAULT_NOTE: PlayerNote = {
  note: '',
  color: '#3b82f6',
  tags: [],
  handsPlayed: 0,
  lastSeen: null,
};

class PlayerNotesServiceClass {
  private cache: Map<string, PlayerNote> = new Map();

  /**
   * Get note for a player
   */
  async getNote(userId: string, targetId: string): Promise<PlayerNote> {
    const cacheKey = `${userId}:${targetId}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const { data, error } = await supabase.rpc('fn_get_player_note', {
      p_user_id: userId,
      p_target_id: targetId,
    });

    if (error || !data || data.length === 0) {
      return DEFAULT_NOTE;
    }

    const row = data[0];
    const note: PlayerNote = {
      note: row.note || '',
      color: row.color || '#3b82f6',
      tags: row.tags || [],
      handsPlayed: row.hands_played || 0,
      lastSeen: row.last_seen ? new Date(row.last_seen) : null,
    };

    this.cache.set(cacheKey, note);
    return note;
  }

  /**
   * Save note for a player
   */
  async saveNote(
    userId: string,
    targetId: string,
    note: string,
    color: string = '#3b82f6',
    tags: string[] = []
  ): Promise<void> {
    // Map hex color to label (DB constraint: none, red, orange, yellow, green, blue, purple)
    const hexToLabel: Record<string, string> = {
      '#ef4444': 'red',
      '#f97316': 'orange',
      '#eab308': 'yellow',
      '#22c55e': 'green',
      '#3b82f6': 'blue',
      '#a855f7': 'purple',
      '#ec4899': 'purple',
      '#6b7280': 'none',
    };
    const colorLabel = hexToLabel[color] || NOTE_COLORS.find((c) => c.id === color)?.id || 'blue';

    await retryAsync(
      () =>
        supabase.rpc('fn_save_player_note', {
          p_user_id: userId,
          p_target_user_id: targetId,
          p_note: note,
          p_color: colorLabel,
          p_tags: tags,
        }),
      3
    );

    // Update cache
    const cacheKey = `${userId}:${targetId}`;
    const current = this.cache.get(cacheKey) || DEFAULT_NOTE;
    this.cache.set(cacheKey, { ...current, note, color, tags, lastSeen: new Date() });
  }

  /**
   * Get all notes for a user (for export)
   */
  async getAllNotes(userId: string): Promise<Map<string, PlayerNote>> {
    const { data, error } = await supabase
      .from('player_notes')
      .select('target_user_id, notes, color_label, tags')
      .eq('user_id', userId)
      .limit(2000);

    const notes = new Map<string, PlayerNote>();

    if (!error && data) {
      for (const row of data) {
        notes.set(row.target_user_id, {
          note: row.notes || '',
          color: row.color_label || '#3b82f6',
          tags: row.tags || [],
          handsPlayed: 0,
          lastSeen: null,
        });
      }
    }

    return notes;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const playerNotesService = new PlayerNotesServiceClass();
