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

/**
 * Canonical NOTE_COLORS — the single source of truth for player note colors.
 * `value` must match the DB CHECK constraint: none, red, orange, yellow, green, blue, purple.
 * `hex` is for UI rendering only.
 */
export const NOTE_COLORS = [
  { id: 'none', value: 'none', hex: '#6b7280', name: 'Default' },
  { id: 'green', value: 'green', hex: '#22c55e', name: 'Green' },
  { id: 'yellow', value: 'yellow', hex: '#eab308', name: 'Yellow' },
  { id: 'orange', value: 'orange', hex: '#f97316', name: 'Orange' },
  { id: 'red', value: 'red', hex: '#ef4444', name: 'Red' },
  { id: 'blue', value: 'blue', hex: '#3b82f6', name: 'Blue' },
  { id: 'purple', value: 'purple', hex: '#a855f7', name: 'Purple' },
];

/**
 * Canonical PLAYER_TAGS — the single source of truth for player tags.
 * Used by PlayerNotes, PlayerNotesPanel, and exported for external consumers.
 */
export const PLAYER_TAGS = [
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
  'Whale',
  'Gambler',
  'Tricky',
];

const DEFAULT_NOTE: PlayerNote = {
  note: '',
  color: '#3b82f6',
  tags: [],
  handsPlayed: 0,
  lastSeen: null,
};

// DB stores a color LABEL (none/red/orange/yellow/green/blue/purple per the
// color_label CHECK); the UI works in hex. These maps keep the two in sync.
const HEX_TO_LABEL: Record<string, string> = {
  '#ef4444': 'red',
  '#f97316': 'orange',
  '#eab308': 'yellow',
  '#22c55e': 'green',
  '#3b82f6': 'blue',
  '#a855f7': 'purple',
  '#ec4899': 'purple',
  '#6b7280': 'none',
};
const LABEL_TO_HEX: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  none: '#6b7280',
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

    // player_notes is a self-owned table (RLS: user_id = auth.uid()); read it
    // directly. There is no fn_get_player_note RPC.
    const { data: row, error } = await supabase
      .from('player_notes')
      .select('notes, color_label, tags')
      .eq('user_id', userId)
      .eq('target_user_id', targetId)
      .maybeSingle();

    if (error || !row) {
      return DEFAULT_NOTE;
    }

    const note: PlayerNote = {
      note: row.notes || '',
      color: LABEL_TO_HEX[row.color_label as string] || '#3b82f6',
      tags: row.tags || [],
      handsPlayed: 0,
      lastSeen: null,
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
    const colorLabel = HEX_TO_LABEL[color] || NOTE_COLORS.find((c) => c.id === color)?.id || 'blue';

    // player_notes is self-owned (RLS: user_id = auth.uid()); write directly.
    // Unique index on (user_id, target_user_id) is partial, so ON CONFLICT
    // inference is unreliable — do an explicit find-then-update/insert instead.
    await retryAsync(async () => {
      const { data: existing, error: readErr } = await supabase
        .from('player_notes')
        .select('id')
        .eq('user_id', userId)
        .eq('target_user_id', targetId)
        .maybeSingle();

      /**
       * A FAILED READ IS NOT "NO NOTE YET" (2026-08-29).
       *
       * Only `data` was destructured here. A Supabase builder RESOLVES with
       * `{data: null, error}` rather than rejecting, so any failure of this
       * lookup — RLS, a network blip, or `.maybeSingle()` raising because more
       * than one row already matched — arrived as `existing === null` and the
       * branch below INSERTED a second note for the same pair. The next call
       * then hits the multi-row error for certain, and inserts again.
       *
       * That is the exact mechanism that took training_user_achievements to
       * 33,353 rows for 44 real pairs. This table has a unique index, so the
       * duplicate is refused rather than written — but `retryAsync` would then
       * spend all three attempts on a 23505 and surface it as a save failure on
       * a note the player already has. Throwing here lets the retry do
       * something useful about a transient read, and stops the write dead on a
       * read that cannot be trusted.
       */
      if (readErr) throw readErr;

      const payload = { notes: note, color_label: colorLabel, tags };

      const { error } = existing?.id
        ? await supabase.from('player_notes').update(payload).eq('id', existing.id)
        : await supabase
            .from('player_notes')
            .insert({ user_id: userId, target_user_id: targetId, ...payload });

      if (error) throw error;
      return true;
    }, 3);

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
          color: LABEL_TO_HEX[row.color_label as string] || '#3b82f6',
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
