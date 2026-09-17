import { describe, expect, it } from 'vitest';
import { runHorseJournalReview } from './horseJournalReview.js';
describe('private Horse journal review command', () => {
  it.each(
    (
      [
        [],
        ['relative', 'a'.repeat(64)],
        ['/private', 'not-a-hash'],
        ['/private', 'a'.repeat(64), 'extra'],
      ] as string[][]
    ).map((args) => ({ args }))
  )('rejects malformed arguments without inspecting storage', ({ args }) => {
    expect(runHorseJournalReview(args)).toEqual({
      code: 64,
      output:
        'Usage: horseJournalReview <absolute-private-journal-directory> <SHA256-hand-coordinate>\n',
    });
  });
  it('returns a failed read without exposing paths or database errors', () => {
    const result = runHorseJournalReview(['/no-such-private-horse-journal', 'a'.repeat(64)]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: 'unavailable',
      gaps: ['storage_unavailable'],
    });
    expect(result.output).not.toContain('/no-such');
  });
});
