/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A NOTE ON A HAND — the player's own, and only theirs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PHASE 5 of the Previous Hand build plan (2026-09-06). Written under the
 * expanded hand in the archive.
 *
 * Two things it will not do, both of them the same principle:
 *
 *   IT NEVER SAYS SAVED UNTIL IT IS. `handNotesService.save` reports whether
 *   the write landed, and a failure leaves the text on screen with "Not
 *   Saved" beside it rather than a tick. A note that exists only in a browser
 *   tab is worse than no note, because the player stops thinking about it.
 *
 *   IT NEVER SHOWS SOMEBODY ELSE'S. There is no author here and no user id -
 *   RLS on `ca_hand_notes` hands this component the caller's own row or
 *   nothing at all, which is why the service takes no user to read for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  handNotesService,
  MAX_TAGS,
  NOTE_MAX_CHARS,
  normaliseTags,
  type HandNote,
} from '../../services/HandNotesService';
import './HandNoteEditor.css';

export interface HandNoteEditorProps {
  handId: string;
  /** The note already loaded by the page, so opening a card costs no fetch. */
  note?: HandNote | null;
  /** Told when a note is written or cleared, so the list can re-filter. */
  onSaved?: (handId: string, note: HandNote | null) => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export default function HandNoteEditor({ handId, note, onSaved }: HandNoteEditorProps) {
  const [text, setText] = useState(note?.note ?? '');
  const [tagText, setTagText] = useState((note?.tags ?? []).join(', '));
  const [state, setState] = useState<SaveState>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* A different hand means a different note; without this, opening a second
     card showed the first card's text. */
  useEffect(() => {
    setText(note?.note ?? '');
    setTagText((note?.tags ?? []).join(', '));
    setState('idle');
  }, [handId, note]);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    []
  );

  const save = useCallback(async () => {
    setState('saving');
    const result = await handNotesService.save(handId, text, tagText);
    if (!result.ok) {
      setState('failed');
      return;
    }
    setState('saved');
    onSaved?.(handId, result.note);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setState('idle'), 2500);
  }, [handId, text, tagText, onSaved]);

  const tags = normaliseTags(tagText);
  const dirty = text !== (note?.note ?? '') || tags.join(',') !== (note?.tags ?? []).join(',');

  return (
    <div className="hand-note">
      <div className="hand-note__head">
        <span className="hand-note__title">Your Note</span>
        <span className="hand-note__private">Private To You</span>
      </div>

      <textarea
        className="hand-note__text"
        value={text}
        maxLength={NOTE_MAX_CHARS}
        rows={3}
        placeholder="What Happened Here, In Your Own Words"
        aria-label="Your Note On This Hand"
        onChange={(e) => setText(e.target.value)}
      />

      <div className="hand-note__tags-row">
        <input
          className="hand-note__tags"
          type="text"
          value={tagText}
          placeholder="Tags, Comma Separated"
          aria-label="Tags For This Hand"
          onChange={(e) => setTagText(e.target.value)}
        />
        <button
          type="button"
          className="hand-note__save"
          onClick={save}
          disabled={state === 'saving' || !dirty}
        >
          {state === 'saving' ? 'Saving' : 'Save Note'}
        </button>
      </div>

      {tags.length > 0 && (
        <div className="hand-note__chips" aria-label="Tags On This Hand">
          {tags.map((t) => (
            <span key={t} className="hand-note__chip">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="hand-note__status" role="status">
        {state === 'saved' && <span className="hand-note__ok">Saved</span>}
        {state === 'failed' && (
          <span className="hand-note__bad">Not Saved. Your Note Is Still Here, Try Again.</span>
        )}
        {state === 'idle' && tags.length >= MAX_TAGS && (
          <span className="hand-note__bad">That Is The Most Tags One Hand Can Carry</span>
        )}
      </div>
    </div>
  );
}
