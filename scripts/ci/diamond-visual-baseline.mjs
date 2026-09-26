#!/usr/bin/env node
/**
 * THE DIAMOND GAMES' VISUAL BASELINE (2026-09-26).
 *
 * Runs scripts/dev/diamond-test-shots.mjs for all four Diamond games against a
 * served build of this commit's fixture page (diamond-test.html: no account,
 * no wallet), at 393 and 1280 wide through each phase, and writes a job
 * summary listing every PNG. The PNGs are uploaded as a workflow artifact by
 * the calling job, so a reviewer can look at the scenes a pull request draws.
 *
 * INFORMATIONAL, NOT A GATE: it is not in the ruleset and cannot block a
 * merge. But it is never silent. It exits non-zero, and names why, when:
 *   - the harness process exits non-zero or cannot start (a crash), or
 *   - a game produced no idle frame at either width (the page never drew), or
 *   - a game produced fewer frames than its phases need.
 * A check that quietly produces nothing is worse than none (CLAUDE.md 10.86).
 * Page errors the fixture raised are listed as warnings in the summary; they
 * are the scene's defect to read, not the harness's crash.
 *
 *   node scripts/ci/diamond-visual-baseline.mjs <baseUrl> <outDir>
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GAMES = ['plinko', 'crash', 'crossing', 'mines'];
export const WIDTHS = [393, 1280];
// Every game draws idle, then open after Start Test; crossing adds a street
// frame, and each settles (booked or settled). Two frames per width is the
// floor below which the round never started.
export const MIN_FRAMES_PER_WIDTH = 2;

/** Judge one game's output directory listing. Pure, so it can be tested. */
export function judgeGame(game, files, exitCode) {
  const problems = [];
  if (exitCode !== 0) problems.push(`the harness exited ${exitCode}`);
  const pngs = files.filter((f) => f.startsWith(`${game}-`) && f.endsWith('.png')).sort();
  for (const width of WIDTHS) {
    const mine = pngs.filter((f) => f.startsWith(`${game}-${width}-`));
    if (!mine.includes(`${game}-${width}-idle.png`)) problems.push(`no idle frame at ${width}`);
    if (mine.length < MIN_FRAMES_PER_WIDTH)
      problems.push(
        `${mine.length} frame(s) at ${width}, expected at least ${MIN_FRAMES_PER_WIDTH}`
      );
  }
  return { game, pngs, problems };
}

export function summaryMarkdown(results, artifactName) {
  const lines = ['## Diamond games visual baseline', ''];
  lines.push(
    `Informational, not a merge gate. Frames are in the workflow artifact \`${artifactName}\`.`,
    ''
  );
  lines.push('| Game | Frames | Result |', '| --- | --- | --- |');
  for (const r of results)
    lines.push(
      `| ${r.game} | ${r.pngs.length} | ${r.problems.length ? `FAILED: ${r.problems.join('; ')}` : 'ok'} |`
    );
  lines.push('');
  for (const r of results) {
    lines.push(
      `**${r.game}**: ${r.pngs.length ? r.pngs.map((p) => `\`${p}\``).join(', ') : 'none'}`
    );
    if (r.pageErrors?.length)
      lines.push(
        '',
        `Page errors raised by the ${r.game} fixture:`,
        ...r.pageErrors.map((e) => `- ${e}`)
      );
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [
    ,
    ,
    baseUrl = 'http://127.0.0.1:4173/hub/club-arena',
    outDir = 'test-results/diamond-visual-baseline',
  ] = process.argv;
  const artifactName = process.env.BASELINE_ARTIFACT ?? 'diamond-visual-baseline';
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const game of GAMES) {
    const started = Date.now();
    const run = spawnSync(
      process.execPath,
      ['scripts/dev/diamond-test-shots.mjs', game, outDir, baseUrl],
      {
        encoding: 'utf8',
        timeout: 5 * 60 * 1000,
        env: { ...process.env, SUPER: '' },
      }
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    process.stdout.write(output);
    const exitCode = run.error
      ? `failed to run (${run.error.code ?? run.error.message})`
      : run.status;
    const files = existsSync(outDir)
      ? readdirSync(outDir).filter((f) => statSync(join(outDir, f)).size > 0)
      : [];
    const result = judgeGame(game, files, exitCode);
    result.pageErrors = output
      .split('\n')
      .filter((l) => l.startsWith('pageerror'))
      .map((l) => l.slice('pageerror'.length).trim());
    for (const e of result.pageErrors)
      console.log(`::warning title=${game} fixture page error::${e}`);
    for (const p of result.problems) console.log(`::error title=${game} visual baseline::${p}`);
    console.log(
      `${game}: ${result.pngs.length} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    results.push(result);
  }
  const summary = summaryMarkdown(results, artifactName);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else console.log(summary);
  const failed = results.filter((r) => r.problems.length);
  if (failed.length) {
    console.log(
      `::error title=Diamond visual baseline::${failed.map((r) => r.game).join(', ')} did not produce a baseline`
    );
    process.exit(1);
  }
}
