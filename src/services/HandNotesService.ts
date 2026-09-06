/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND NOTES — a player's own record of what they thought
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 5 of the Previous Hand build plan (2026-09-06). A note on a hand is
 * private: it is what a player thought about the way somebody else played, and
 * it is nobody else's business. The privacy is Postgres's, not this file's -
 * `ca_hand_notes` carries RLS on all four commands against `auth.uid()`, and
 * the grant is to `authenticated` alone (see the migration). This service could
 * ask for every note on the platform and be handed only its own.
 *
 * That is deliberate and it is the reason there is no `userId` parameter
 * anywhere below. A service that takes an id can be called with the wrong one;
 * one that cannot name a user can only ever read and write the caller's rows.
 *
 * LIMITS ARE THE DATABASE'S TOO. The note is capped at 2,000 characters and a
 * hand may carry 12 tags of 24 characters, checked by CHECK constraints. The
 * trimming here is so a player sees the cap in the UI rather than an error
 * from Postgres; it is not what enforces it.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface HandNote {
  handId: string;
  note: string;
  tags: string[];
  updatedAt: string | null;
}

/** The caps, mirrored from the migration's CHECK constraints. */
export const NOTE_MAX_CHARS = 2000;
export const TAG_MAX_CHARS = 24;
export const MAX_TAGS = 12;

/**
 * Tags are compared and stored lower-case, trimmed, deduplicated, and without
 * a leading '#' - a player types "#leak" and "Leak" and means one tag.
 */
export function normaliseTags(input: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? '')
        .split(/[,\n]/)
        .map((t) => t);
  const out: string[] = [];
  for (const t of raw) {
    const tag = String(t ?? '')
      .trim()
      .replace(/^#+/, '')
      .toLowerCase()
      .slice(0, TAG_MAX_CHARS);
    if (!tag) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Trim a note to the cap the database will enforce anyway. */
export function normaliseNote(input: string | null | undefined): string {
  return String(input ?? '').slice(0, NOTE_MAX_CHARS);
}

function rowToNote(row: {
  hand_id: string;
  note?: string | null;
  tags?: string[] | null;
  updated_at?: string | null;
}): HandNote {
  return {
    handId: row.hand_id,
    note: row.note ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    updatedAt: row.updated_at ?? null,
  };
}

export const handNotesService = {
  /**
   * Every note the caller has, newest first. Used by the archive to show which
   * hands are noted and to search their text without a round trip per card.
   *
   * A failure returns an EMPTY MAP, never throws: a note is an enrichment, and
   * a hand history that will not load because a note service is unwell is a
   * worse outcome than a hand history with no notes on it.
   */
  async listMine(limit = 500): Promise<Map<string, HandNote>> {
    try {
      const { data, error } = await supabase
        .from('ca_hand_notes')
        .select('hand_id, note, tags, updated_at')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      const out = new Map<string, HandNote>();
      for (const row of data ?? []) out.set(row.hand_id, rowToNote(row));
      return out;
    } catch (error) {
      reportError(error, 'HandNotesService.listMine');
      return new Map();
    }
  },

  /** One hand's note, or null when there is none (or it could not be read). */
  async getOne(handId: string): Promise<HandNote | null> {
    if (!handId) return null;
    try {
      const { data, error } = await supabase
        .from('ca_hand_notes')
        .select('hand_id, note, tags, updated_at')
        .eq('hand_id', handId)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToNote(data) : null;
    } catch (error) {
      reportError(error, 'HandNotesService.getOne');
      return null;
    }
  },

  /**
   * Write the caller's note on a hand, creating or replacing it.
   *
   * An EMPTY note with NO tags deletes the row rather than storing a blank
   * one, so "hands I noted" means hands that actually carry something and
   * clearing a note is the same gesture as never writing one.
   *
   * Returns the note as stored, or null when the write failed - and it says
   * which, so a surface can tell the player it did not save instead of
   * showing them text that is only in their browser.
   */
  async save(
    handId: string,
    note: string,
    tags: string[] | string
  ): Promise<{ ok: boolean; note: HandNote | null }> {
    if (!handId) return { ok: false, note: null };
    const cleanNote = normaliseNote(note).trim();
    const cleanTags = normaliseTags(tags);

    if (!cleanNote && cleanTags.length === 0) {
      const removed = await this.remove(handId);
      return { ok: removed, note: null };
    }

    try {
      /* The row's user_id is the caller's own. RLS would refuse anything else,
         but the column is NOT NULL so it has to be sent - and a failure to ask
         WHO the caller is must not be read as "no user", which would report a
         save that never happened as a plain empty note. */
      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      const userId = auth?.user?.id;
      if (!userId) return { ok: false, note: null };

      const { data, error } = await supabase
        .from('ca_hand_notes')
        .upsert(
          { user_id: userId, hand_id: handId, note: cleanNote, tags: cleanTags },
          { onConflict: 'user_id,hand_id' }
        )
        .select('hand_id, note, tags, updated_at')
        .maybeSingle();
      if (error) throw error;
      return { ok: true, note: data ? rowToNote(data) : null };
    } catch (error) {
      reportError(error, 'HandNotesService.save');
      return { ok: false, note: null };
    }
  },

  /** Delete the caller's note on a hand. True when it is gone. */
  async remove(handId: string): Promise<boolean> {
    if (!handId) return false;
    try {
      const { error } = await supabase.from('ca_hand_notes').delete().eq('hand_id', handId);
      if (error) throw error;
      return true;
    } catch (error) {
      reportError(error, 'HandNotesService.remove');
      return false;
    }
  },
};

export default handNotesService;
