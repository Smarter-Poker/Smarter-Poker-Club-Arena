/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A NOTE IS NEVER LOST QUIETLY — Phase 5 deep dive, 2026-09-06
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three defects found by reading the wiring rather than the tests, all of them
 * the same shape: the editor could not tell a fact from the absence of an
 * answer, and a save is an UPSERT, so it replaces whatever row is there.
 *
 *   1. IT COULD NEVER SAY "SAVED". The page hands the note back down after a
 *      save, as a new object in a new Map; the editor's reset effect was keyed
 *      on that object's IDENTITY, so it re-ran and set the state back to idle
 *      before the confirmation could be read. The file's own header says its
 *      first principle is that it never says Saved until it is - it never said
 *      it at all. The same effect wiped text a player was in the middle of
 *      typing whenever the page's map changed for any other reason.
 *
 *   2. A NOTE THE PAGE HAD NOT LOADED OPENED BLANK. The map came from a
 *      "newest 500" list, so an older note simply was not in it; the hand read
 *      as un-noted, and a save wrote over a note the player had written and
 *      could not see.
 *
 *   3. AN UNREADABLE ROW LOOKED LIKE AN EMPTY ONE. `getOne` returned null both
 *      for "there is no note" and for "I could not find out".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const getOne = vi.fn();
const save = vi.fn();

vi.mock('../../src/services/HandNotesService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/HandNotesService')>(
    '../../src/services/HandNotesService'
  );
  return {
    ...actual,
    handNotesService: {
      getOne: (...args: unknown[]) => getOne(...args),
      save: (...args: unknown[]) => save(...args),
      listFor: vi.fn().mockResolvedValue(new Map()),
      remove: vi.fn().mockResolvedValue(true),
    },
    default: undefined,
  };
});

import HandNoteEditor from '../../src/components/handdetail/HandNoteEditor';
import type { HandNote } from '../../src/services/HandNotesService';

const note = (text: string, tags: string[] = []): HandNote => ({
  handId: 'hand-1',
  note: text,
  tags,
  updatedAt: '2026-09-06T00:00:00.000Z',
});

describe('a note is never lost quietly', () => {
  beforeEach(() => {
    getOne.mockReset();
    save.mockReset();
    getOne.mockResolvedValue({ ok: true, note: null });
  });
  afterEach(cleanup);

  it('says Saved, and the note coming back down does not wipe the word', async () => {
    save.mockResolvedValue({ ok: true, note: note('he folds the river too much') });
    const { rerender } = render(<HandNoteEditor handId="hand-1" note={null} />);
    await screen.findByRole('button', { name: /save note/i });

    fireEvent.change(screen.getByLabelText(/your note on this hand/i), {
      target: { value: 'he folds the river too much' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));
    await screen.findByText('Saved');

    /* The page re-renders with the saved note as a FRESH object, which is what
       `setNotes(new Map(...))` produces. Identity changed; content did not. */
    rerender(<HandNoteEditor handId="hand-1" note={note('he folds the river too much')} />);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('does not wipe what is being typed when the page re-renders its map', async () => {
    const { rerender } = render(<HandNoteEditor handId="hand-1" note={note('first thought')} />);
    fireEvent.change(screen.getByLabelText(/your note on this hand/i), {
      target: { value: 'first thought, and a second one' },
    });
    /* Same content, new object - a sibling card saving its own note is enough. */
    rerender(<HandNoteEditor handId="hand-1" note={note('first thought')} />);
    expect((screen.getByLabelText(/your note on this hand/i) as HTMLTextAreaElement).value).toBe(
      'first thought, and a second one'
    );
  });

  it('asks for the row itself when the page had nothing, and shows what it finds', async () => {
    getOne.mockResolvedValue({ ok: true, note: note('older than the page ever loaded', ['leak']) });
    render(<HandNoteEditor handId="hand-1" note={null} />);
    await waitFor(() =>
      expect((screen.getByLabelText(/your note on this hand/i) as HTMLTextAreaElement).value).toBe(
        'older than the page ever loaded'
      )
    );
    expect(getOne).toHaveBeenCalledWith('hand-1');
    /* And it did not offer to overwrite before it knew. */
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses to save over a row it could not read, and says so', async () => {
    getOne.mockResolvedValue({ ok: false, note: null });
    render(<HandNoteEditor handId="hand-1" note={null} />);
    await screen.findByText(/could not read your note/i);
    fireEvent.change(screen.getByLabelText(/your note on this hand/i), {
      target: { value: 'something new' },
    });
    expect((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('never says Saved when the write did not land', async () => {
    save.mockResolvedValue({ ok: false, note: null });
    render(<HandNoteEditor handId="hand-1" note={note('')} />);
    fireEvent.change(screen.getByLabelText(/your note on this hand/i), {
      target: { value: 'this will not land' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save note/i }));
    await screen.findByText(/not saved/i);
    expect(screen.queryByText('Saved')).toBeNull();
    /* The words stay on screen: a note that exists only in a browser tab is
       worse than no note, because the player stops thinking about it. */
    expect((screen.getByLabelText(/your note on this hand/i) as HTMLTextAreaElement).value).toBe(
      'this will not land'
    );
  });

  it('trusts the page only when the page ASKED about this hand', async () => {
    /* `listFor(handIds)` answers for exactly the hands on screen, so a hand
       missing from that answer genuinely has no note and a second read would
       be a round trip per expanded card at a live table. Silence is not the
       same thing, and gets asked. */
    render(<HandNoteEditor handId="hand-1" note={null} noteKnown />);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled
      ).toBe(true)
    );
    expect(getOne).not.toHaveBeenCalled();

    cleanup();
    render(<HandNoteEditor handId="hand-1" note={null} />);
    await waitFor(() => expect(getOne).toHaveBeenCalledWith('hand-1'));
  });

  it('a different hand starts from that hand, not from the last one', async () => {
    const { rerender } = render(<HandNoteEditor handId="hand-1" note={note('about hand one')} />);
    expect((screen.getByLabelText(/your note on this hand/i) as HTMLTextAreaElement).value).toBe(
      'about hand one'
    );
    getOne.mockResolvedValue({ ok: true, note: null });
    rerender(<HandNoteEditor handId="hand-2" note={null} />);
    await waitFor(() =>
      expect((screen.getByLabelText(/your note on this hand/i) as HTMLTextAreaElement).value).toBe(
        ''
      )
    );
  });
});
