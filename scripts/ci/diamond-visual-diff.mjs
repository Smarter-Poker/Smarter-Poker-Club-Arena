#!/usr/bin/env node
/**
 * WHAT A PULL REQUEST CHANGED IN THE DIAMOND SCENES, PIXEL BY PIXEL (2026-10-01).
 *
 * diamond-visual-baseline.yml shoots every Diamond game at 393 and 1280 wide
 * through each phase, once for the pull request and once for the commit it
 * merges into, with the same harness. This compares the two sets frame by
 * frame and writes, for each frame both sides drew, the share of pixels that
 * moved and a diff image (changed pixels in red over a dimmed copy of the
 * pull request's frame), plus a job summary table that leads with the frames
 * that changed most.
 *
 * It decodes and compares in the Chromium the job already installed, so it adds
 * no dependency. The comparison itself is `comparePixels`, a pure function the
 * page runs as written here (tests/unit/diamondVisualDiff.test.ts).
 *
 * INFORMATIONAL, like the job it runs in. A changed frame is something for a
 * reviewer to look at, not a failure: the scenes animate on software WebGL and
 * a phase can be caught a few frames apart. It exits non-zero only when it
 * cannot do its work at all (no pull request frames, or the browser failed).
 * A base that could not be shot is reported in the summary, not as a failure.
 *
 *   node scripts/ci/diamond-visual-diff.mjs <baseDir> <headDir> <outDir>
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A channel moving by this much or less is rendering noise, not a change. */
export const CHANNEL_TOLERANCE = 24;
/** A frame with more than this share of its pixels moved is listed as changed. */
export const CHANGED_SHARE = 0.005;

/**
 * Compare two RGBA buffers of the same size. Returns how many pixels moved by
 * more than `tolerance` on any channel, and a diff image: moved pixels red,
 * the rest the head frame at a quarter of its brightness. Pure, and run inside
 * the page exactly as written, so keep it free of anything but its arguments.
 */
export function comparePixels(base, head, tolerance) {
  const length = head.length;
  const diff = new Uint8ClampedArray(length);
  let changed = 0;
  for (let i = 0; i < length; i += 4) {
    const moved =
      Math.abs(base[i] - head[i]) > tolerance ||
      Math.abs(base[i + 1] - head[i + 1]) > tolerance ||
      Math.abs(base[i + 2] - head[i + 2]) > tolerance ||
      Math.abs(base[i + 3] - head[i + 3]) > tolerance;
    if (moved) {
      changed += 1;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
    } else {
      diff[i] = head[i] >> 2;
      diff[i + 1] = head[i + 1] >> 2;
      diff[i + 2] = head[i + 2] >> 2;
    }
    diff[i + 3] = 255;
  }
  return { changed, total: length / 4, diff };
}

/** Which frames each side has, and which only one side has. */
export function pairFrames(baseFiles, headFiles) {
  const png = (f) => f.endsWith('.png');
  const base = new Set(baseFiles.filter(png));
  const head = headFiles.filter(png).sort();
  return {
    both: head.filter((f) => base.has(f)),
    onlyHead: head.filter((f) => !base.has(f)),
    onlyBase: [...base].filter((f) => !head.includes(f)).sort(),
  };
}

const pct = (share) => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 3 : 2)}%`;

/** The job summary. Results: { frame, share, sizeChanged } in any order. */
export function diffSummary({ results, onlyHead, onlyBase, baseMissing, artifactName }) {
  const lines = ['## Diamond games: what this pull request changed', ''];
  if (baseMissing) {
    lines.push(
      'The base commit could not be shot, so there is nothing to compare against this time. ' +
        'The pull request frames are still in the artifact.',
      ''
    );
    return lines.join('\n');
  }
  const changed = results.filter((r) => r.sizeChanged || r.share > CHANGED_SHARE);
  lines.push(
    `Informational, not a merge gate. ${changed.length} of ${results.length} frames changed by more than ` +
      `${pct(CHANGED_SHARE)} of their pixels. Diff images (moved pixels in red) are in \`diff/\` ` +
      `of the workflow artifact \`${artifactName}\`.`,
    ''
  );
  lines.push('| Frame | Pixels moved | |', '| --- | --- | --- |');
  const ordered = [...results].sort(
    (a, b) => Number(b.sizeChanged) - Number(a.sizeChanged) || b.share - a.share
  );
  for (const r of ordered)
    lines.push(
      `| \`${r.frame}\` | ${r.sizeChanged ? 'size changed' : pct(r.share)} | ${
        r.sizeChanged || r.share > CHANGED_SHARE ? 'Changed' : ''
      } |`
    );
  if (onlyHead.length)
    lines.push('', `New in this pull request: ${onlyHead.map((f) => `\`${f}\``).join(', ')}`);
  if (onlyBase.length)
    lines.push('', `No longer drawn: ${onlyBase.map((f) => `\`${f}\``).join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

async function compareInBrowser(page, basePng, headPng, tolerance) {
  return page.evaluate(
    async ({ base, head, tolerance, compareSource }) => {
      const compare = new Function(`return (${compareSource})`)();
      const decode = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return {
          width: bitmap.width,
          height: bitmap.height,
          data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
        };
      };
      const [a, b] = await Promise.all([decode(base), decode(head)]);
      if (a.width !== b.width || a.height !== b.height) return { sizeChanged: true, share: 1 };
      const { changed, total, diff } = compare(a.data, b.data, tolerance);
      const canvas = new OffscreenCanvas(b.width, b.height);
      canvas.getContext('2d').putImageData(new ImageData(diff, b.width, b.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const out = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < out.length; i += 0x8000)
        binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return { sizeChanged: false, share: total ? changed / total : 0, diffPng: btoa(binary) };
    },
    {
      base: basePng.toString('base64'),
      head: headPng.toString('base64'),
      tolerance,
      compareSource: comparePixels.toString(),
    }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , baseDir, headDir, outDir] = process.argv;
  if (!baseDir || !headDir || !outDir) {
    console.error('usage: node scripts/ci/diamond-visual-diff.mjs <baseDir> <headDir> <outDir>');
    process.exit(2);
  }
  const artifactName = process.env.BASELINE_ARTIFACT ?? 'diamond-visual-baseline';
  const write = (text) =>
    process.env.GITHUB_STEP_SUMMARY
      ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
      : console.log(text);
  const list = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  const headFiles = list(headDir);
  if (!headFiles.some((f) => f.endsWith('.png'))) {
    console.log(`::error title=Diamond visual diff::no pull request frames in ${headDir}`);
    process.exit(1);
  }
  const baseFiles = list(baseDir);
  if (!baseFiles.some((f) => f.endsWith('.png'))) {
    console.log(
      '::warning title=Diamond visual diff::the base commit drew no frames; nothing to compare'
    );
    write(
      diffSummary({ results: [], onlyHead: [], onlyBase: [], baseMissing: true, artifactName })
    );
    process.exit(0);
  }
  const { both, onlyHead, onlyBase } = pairFrames(baseFiles, headFiles);
  mkdirSync(outDir, { recursive: true });
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>diff</title>');
    for (const frame of both) {
      const r = await compareInBrowser(
        page,
        readFileSync(join(baseDir, frame)),
        readFileSync(join(headDir, frame)),
        CHANNEL_TOLERANCE
      );
      if (r.diffPng) writeFileSync(join(outDir, frame), Buffer.from(r.diffPng, 'base64'));
      results.push({ frame, share: r.share, sizeChanged: r.sizeChanged });
      console.log(`${frame}: ${r.sizeChanged ? 'size changed' : pct(r.share)}`);
    }
  } finally {
    await browser.close();
  }
  write(diffSummary({ results, onlyHead, onlyBase, baseMissing: false, artifactName }));
}
