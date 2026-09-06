/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FLAGGING A HAND — the player's route to their club's operators
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 6 of the Previous Hand build plan (2026-09-06).
 *
 * Before this, the only way to raise a hand was `ReportPlayerPage`, which has
 * a hand-id field and folds it into free text - `Hand: 6421788` inside a
 * paragraph. No operator could open the hand it named, nothing could count how
 * many flags one hand had, and the player was never told what happened.
 *
 * EVERY WRITE GOES THROUGH A DEFINER FUNCTION, and that is the design rather
 * than a preference. `ca_hand_flags` has no INSERT, UPDATE or DELETE policy at
 * all:
 *
 *   - `fn_ca_flag_hand` derives the club from the HAND, so a caller cannot
 *     file a flag at a club they chose, and it refuses a hand the caller was
 *     not dealt into. A client that could set `club_id` itself could put a
 *     flag in front of operators who have no business seeing it.
 *   - `fn_ca_resolve_hand_flag` requires a note when it closes one, and writes
 *     an `audit_trail` row for the change.
 *
 * READS are plain RLS: the player sees their own rows, club staff see their
 * club's. That is why this file has no `userId` parameter anywhere - the same
 * reason `HandNotesService` has none.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export type HandFlagStatus = 'open' | 'under_review' | 'resolved' | 'dismissed';

export interface HandFlag {
  id: string;
  handId: string;
  clubId: string;
  handNumber: number | null;
  tableId: string | null;
  tableName?: string | null;
  flaggedBy: string;
  note: string;
  status: HandFlagStatus;
  operatorNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The caps the database enforces; mirrored so a surface can show them. */
export const FLAG_NOTE_MIN = 4;
export const FLAG_NOTE_MAX = 2000;
/** The reason a godmode read has to give, in characters. */
export const GODMODE_REASON_MIN = 8;

export const FLAG_STATUS_LABEL: Record<HandFlagStatus, string> = {
  open: 'Open',
  under_review: 'Under Review',
  resolved: 'Resolved',
  dismissed: 'Closed, No Change',
};

function rowToFlag(row: Record<string, unknown>): HandFlag {
  return {
    id: String(row.id),
    handId: String(row.hand_id),
    clubId: String(row.club_id ?? ''),
    handNumber: row.hand_number == null ? null : Number(row.hand_number),
    tableId: row.table_id == null ? null : String(row.table_id),
    tableName: (row.table_name as string | null) ?? null,
    flaggedBy: String(row.flagged_by ?? ''),
    note: String(row.note ?? ''),
    status: (row.status as HandFlagStatus) ?? 'open',
    operatorNote: (row.operator_note as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/**
 * The operator's view of one hand, with every seat's holding.
 *
 * `cardsComplete` is not decoration. `hand_history` reaches back further than
 * `ca_hand_facts` does, so an old enough hand has seats whose holdings are
 * gone - and an absent holding must never be read as an empty one by somebody
 * about to settle a dispute on it.
 */
export interface OperatorHandRead {
  /** The `hand_history` row, in the shape `replayInputFromRow` already reads. */
  row: Record<string, unknown>;
  /** `user_id` -> that seat's cards, shown or not. */
  allHoleCards: Record<string, unknown>;
  seatsDealt: number;
  seatsWithCards: number;
  cardsComplete: boolean;
}

export const handFlagService = {
  /**
   * File a flag on a hand the caller played. The club is derived from the
   * hand, server-side.
   *
   * Returns the stored flag, or an error message the surface can show. It
   * never silently succeeds: a flag the player believes was filed and was not
   * is the failure this whole feature exists to avoid.
   */
  async flag(
    handId: string,
    note: string
  ): Promise<{ ok: boolean; flag: HandFlag | null; error?: string }> {
    if (!handId) return { ok: false, flag: null, error: 'No Hand To Flag' };
    const clean = String(note ?? '').trim();
    if (clean.length < FLAG_NOTE_MIN) {
      return { ok: false, flag: null, error: 'Say What Looked Wrong' };
    }
    try {
      const { data, error } = await supabase.rpc('fn_ca_flag_hand', {
        p_hand_id: handId,
        p_note: clean.slice(0, FLAG_NOTE_MAX),
      });
      if (error) throw error;
      return { ok: true, flag: data ? rowToFlag(data as Record<string, unknown>) : null };
    } catch (error) {
      reportError(error, 'HandFlagService.flag');
      return { ok: false, flag: null, error: 'Could Not Send That To The Operators' };
    }
  },

  /**
   * The caller's own flags on these hands. RLS returns nobody else's.
   *
   * By hand id, for the same reason the notes are: a "my newest N" list leaves
   * an older flag out of the map, and the hand then reads as never flagged.
   */
  async mineFor(handIds: string[]): Promise<Map<string, HandFlag>> {
    const out = new Map<string, HandFlag>();
    const ids = [...new Set((handIds ?? []).filter(Boolean))];
    if (ids.length === 0) return out;
    const CHUNK = 200;
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase
          .from('ca_hand_flags')
          .select(
            'id, hand_id, club_id, hand_number, table_id, flagged_by, note, status, operator_note, reviewed_by, reviewed_at, created_at, updated_at'
          )
          .in('hand_id', ids.slice(i, i + CHUNK));
        if (error) throw error;
        for (const row of data ?? []) out.set(String(row.hand_id), rowToFlag(row));
      }
      return out;
    } catch (error) {
      reportError(error, 'HandFlagService.mineFor');
      return out;
    }
  },

  /** The club's queue. Refused by Postgres for anyone who is not club staff. */
  async clubQueue(
    clubId: string,
    status?: HandFlagStatus | 'all'
  ): Promise<{ ok: boolean; flags: HandFlag[]; denied?: boolean }> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_club_hand_flags', {
        p_club_id: clubId,
        p_status: status && status !== 'all' ? status : null,
        p_limit: 200,
      });
      if (error) throw error;
      return { ok: true, flags: (data ?? []).map((r: Record<string, unknown>) => rowToFlag(r)) };
    } catch (error) {
      const denied = isDenied(error);
      if (!denied) reportError(error, 'HandFlagService.clubQueue');
      return { ok: false, flags: [], denied };
    }
  },

  /** Move a flag. Closing one needs a note the player can read; Postgres insists. */
  async resolve(
    flagId: string,
    status: HandFlagStatus,
    operatorNote?: string
  ): Promise<{ ok: boolean; flag: HandFlag | null; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('fn_ca_resolve_hand_flag', {
        p_flag_id: flagId,
        p_status: status,
        p_operator_note: operatorNote?.trim() ? operatorNote.trim() : null,
      });
      if (error) throw error;
      return { ok: true, flag: data ? rowToFlag(data as Record<string, unknown>) : null };
    } catch (error) {
      reportError(error, 'HandFlagService.resolve');
      return {
        ok: false,
        flag: null,
        error:
          status === 'resolved' || status === 'dismissed'
            ? 'Closing A Flag Needs A Note The Player Can Read'
            : 'Could Not Update That Flag',
      };
    }
  },

  /**
   * THE AUDITED READ. Every seat's holding for one hand at this club.
   *
   * There is no unlogged variant of this call and there cannot be: the
   * function writes the `audit_trail` row in the same transaction that returns
   * the cards, `audit_trail` REVOKEs INSERT from `authenticated`, and neither
   * `hand_history` nor `ca_hand_facts` will show an operator another player's
   * row. The reason travels into the log verbatim, which is why the surface
   * asks for one rather than sending a placeholder.
   */
  async openHand(
    clubId: string,
    handNumber: number,
    reason: string
  ): Promise<{ ok: boolean; read: OperatorHandRead | null; error?: string }> {
    const why = String(reason ?? '').trim();
    if (why.length < GODMODE_REASON_MIN) {
      return { ok: false, read: null, error: 'Say Why This Hand Is Being Opened' };
    }
    try {
      const { data, error } = await supabase.rpc('fn_ca_operator_read_hand', {
        p_club_id: clubId,
        p_hand_number: handNumber,
        p_reason: why,
      });
      if (error) throw error;
      const row = (data ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        read: {
          row,
          allHoleCards: (row.all_hole_cards as Record<string, unknown>) ?? {},
          seatsDealt: Number(row.seats_dealt ?? 0),
          seatsWithCards: Number(row.seats_with_cards ?? 0),
          cardsComplete: row.cards_complete === true,
        },
      };
    } catch (error) {
      const message = errorText(error);
      /* The database's own refusals are the honest words for these, so they
         are surfaced rather than flattened into "something went wrong". */
      if (/only a club owner or admin/i.test(message)) {
        return { ok: false, read: null, error: 'Only A Club Owner Or Admin May Open A Hand' };
      }
      if (/not dealt at this club/i.test(message)) {
        return { ok: false, read: null, error: 'That Hand Was Not Dealt At This Club' };
      }
      if (/no hand numbered/i.test(message)) {
        return { ok: false, read: null, error: 'No Hand With That Number' };
      }
      reportError(error, 'HandFlagService.openHand');
      return { ok: false, read: null, error: 'Could Not Open That Hand' };
    }
  },
};

function errorText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const e = error as { message?: string; details?: string; hint?: string };
  return [e.message, e.details, e.hint].filter(Boolean).join(' ');
}

function isDenied(error: unknown): boolean {
  return /not an operator of this club|permission denied|42501/i.test(errorText(error));
}

export default handFlagService;
