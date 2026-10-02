/**
 * The Diamond visual diff (2026-10-01): what a pull request changed in the
 * scenes, frame by frame, against the commit it merges into.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CHANGED_SHARE,
  CHANNEL_TOLERANCE,
  comparePixels,
  diffSummary,
  pairFrames,
} from '../../scripts/ci/diamond-visual-diff.mjs';

const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

describe('comparePixels', () => {
  it('counts a pixel as moved only past the tolerance, on any channel', () => {
    const base = rgba([10, 10, 10, 255], [10, 10, 10, 255], [10, 10, 10, 255]);
    const head = rgba(
      [10 + CHANNEL_TOLERANCE, 10, 10, 255],
      [10, 10 + CHANNEL_TOLERANCE + 1, 10, 255],
      [10, 10, 10, 0]
    );
    const { changed, total } = comparePixels(base, head, CHANNEL_TOLERANCE);
    expect(total).toBe(3);
    expect(changed).toBe(2);
  });

  it('paints moved pixels red and dims the rest of the head frame', () => {
    const { diff } = comparePixels(
      rgba([0, 0, 0, 255], [200, 100, 40, 255]),
      rgba([255, 255, 255, 255], [200, 100, 40, 255]),
      CHANNEL_TOLERANCE
    );
    expect([...diff]).toEqual([255, 0, 0, 255, 50, 25, 10, 255]);
  });

  it('runs on its own, so the page can evaluate it as written', () => {
    const rebuilt = new Function(`return (${comparePixels.toString()})`)() as typeof comparePixels;
    expect(rebuilt(rgba([0, 0, 0, 255]), rgba([0, 0, 0, 255]), 0).changed).toBe(0);
  });
});

describe('pairing and the summary', () => {
  it('compares the frames both sides drew and names the rest', () => {
    expect(pairFrames(['a.png', 'b.png', 'base', 'notes.txt'], ['b.png', 'c.png', 'diff'])).toEqual(
      { both: ['b.png'], onlyHead: ['c.png'], onlyBase: ['a.png'] }
    );
  });

  it('leads with the frames that changed most and marks only real changes', () => {
    const text = diffSummary({
      results: [
        { frame: 'crash-393-idle.png', share: CHANGED_SHARE / 2, sizeChanged: false },
        { frame: 'plinko-393-open.png', share: 0.2, sizeChanged: false },
        { frame: 'mines-1280-idle.png', share: 1, sizeChanged: true },
      ],
      onlyHead: ['crossing-393-street.png'],
      onlyBase: [],
      baseMissing: false,
      artifactName: 'art',
    });
    const rows = text.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows[0]).toContain('mines-1280-idle.png');
    expect(rows[0]).toContain('size changed');
    expect(rows[1]).toContain('plinko-393-open.png');
    expect(rows[1]).toContain('Changed');
    expect(rows[2]).not.toContain('Changed');
    expect(text).toContain('2 of 3 frames changed');
    expect(text).toContain('New in this pull request: `crossing-393-street.png`');
  });

  it('says plainly when there was no base to compare against', () => {
    expect(
      diffSummary({ results: [], onlyHead: [], onlyBase: [], baseMissing: true, artifactName: 'x' })
    ).toContain('nothing to compare');
  });
});

describe('the workflow compares against the base and still never gates', () => {
  const workflow = parse(readFileSync('.github/workflows/diamond-visual-baseline.yml', 'utf8'));
  const steps: {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
    'continue-on-error'?: boolean;
    with?: Record<string, string>;
  }[] = workflow.jobs.shots.steps;
  const named = (name: string) => steps.find((s) => s.name === name)!;

  it('checks out, builds, serves and shoots the base, each allowed to fail', () => {
    expect(named('Check out the base commit').with!.ref).toBe(
      '${{ github.event.pull_request.base.sha }}'
    );
    for (const name of [
      'Check out the base commit',
      "Build the base commit's fixture page",
      "Serve the base commit's fixture page",
      'Screenshot the base commit the same way',
    ])
      expect(named(name)['continue-on-error'], name).toBe(true);
  });

  it('compares every frame before the upload, so the diffs ship in the artifact', () => {
    const compare = named('Compare every frame with the base');
    expect(compare.run).toContain('node scripts/ci/diamond-visual-diff.mjs');
    expect(compare.if).toContain('always()');
    expect(steps.indexOf(compare)).toBeLessThan(steps.indexOf(named('Upload the frames')));
  });

  it('runs when the diff script itself changes', () => {
    expect(workflow.on.pull_request.paths).toContain('scripts/ci/diamond-visual-diff.mjs');
  });
});
