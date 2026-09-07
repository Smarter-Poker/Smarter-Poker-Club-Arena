#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUILD THE THROWABLE CUES (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reads scripts/audio/throwable-cues.manifest.json and, for every cue that is
 * not a placeholder, layers its source files with ffmpeg (adelay + amix),
 * trims, sets the level (each mix is measured and peak-normalised to the
 * manifest's true-peak target, offset by the cue's own `levelDb`), and writes
 *
 *   public/sounds/throwables/<cue>.webm   Opus, 48 kHz, mono
 *   public/sounds/throwables/<cue>.m4a    AAC, for Safari
 *   public/sounds/throwables/CREDITS.md   every cue -> source, file(s), licence
 *   src/throwables/cueManifest.generated.ts   the client's view (placeholders too)
 *
 * SOURCES are NOT in the repo (the Kenney packs are 800 KB zips each). Pass
 * `--sources <dir>`; with `--fetch` the script downloads each Kenney pack into
 * that dir from the asset page's own zip link (kenney.nl publishes a fresh
 * hashed URL per release, so it is scraped, not hardcoded). Freesound and
 * Sonniss sources (phase 6) are placed by hand under the same dir; the
 * manifest row records the id and licence.
 *
 * Every licence in the manifest must be in `allowedLicenses` or the build
 * refuses. tests/unit/throwableCuesAreLicensed.test.ts checks the same thing
 * from the generated file, so a hand-edited generated file cannot smuggle one.
 *
 * Usage:
 *   node scripts/audio/build-throwable-cues.mjs --sources ~/throwable-sources/kenney [--fetch] [--only cue,cue]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const manifestPath = join(here, 'throwable-cues.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const sourcesDir = resolve(argOf('--sources') || join(process.env.HOME || '.', 'throwable-sources', 'kenney'));
const doFetch = args.includes('--fetch');
const only = argOf('--only')?.split(',').filter(Boolean);
const outDir = join(repo, manifest.outputDir);
const generatedPath = join(repo, 'src', 'throwables', 'cueManifest.generated.ts');

function fail(msg) {
  console.error(`build-throwable-cues: ${msg}`);
  process.exit(1);
}

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * The quietest a shipped cue may peak. Derived, not guessed: the thirteen cues
 * built on 2026-09-06 peak between -1.8 and -19.2 dBFS, and the one defect in
 * the set peaked at -36.1. -30 sits below every good cue with 11 dB of room
 * and above the defect with 6, so it separates them without being tuned to
 * either. A cue below this is inaudible under a table with chips and voices.
 */
const QUIET_FLOOR_DB = -30;

/** Peak level of a built file, in dBFS, or null when it cannot be measured. */
function peakDbOf(file) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(`${r.stderr || ''}${r.stdout || ''}`);
  // "-inf" (pure silence) does not match the number pattern, and neither does a
  // failed run. Both are "I could not tell it is loud enough", which is NOT the
  // same as fine (CLAUDE.md 10.86 rule 1) - the caller refuses on null.
  return m ? Number(m[1]) : null;
}

// ── Licences: refuse anything not on the allowlist, before touching ffmpeg ──
for (const [key, src] of Object.entries(manifest.sources)) {
  if (!manifest.allowedLicenses.includes(src.license)) {
    fail(`source '${key}' carries licence '${src.license}', which is not allowed`);
  }
}

// ── Optional fetch of the Kenney packs ──────────────────────────────────────
async function fetchKenney(src) {
  const dest = join(sourcesDir, src.slug);
  if (existsSync(join(sourcesDir, src.dir))) return;
  console.log(`fetching ${src.title} ...`);
  const page = await (await fetch(src.url)).text();
  const m = page.match(new RegExp(`https://kenney\\.nl/media/pages/assets/${src.slug}/[^'"]*\\.zip`));
  if (!m) fail(`could not find the zip link on ${src.url}`);
  const zip = Buffer.from(await (await fetch(m[0])).arrayBuffer());
  mkdirSync(dest, { recursive: true });
  const zipPath = join(sourcesDir, `${src.slug}.zip`);
  writeFileSync(zipPath, zip);
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest]);
}

// ── OpenGameArt: a direct zip on a stable path, and a licence per SUBMISSION.
// Unlike Kenney (whose whole site is CC0) OGA hosts CC0, CC-BY, OGA-BY and GPL
// side by side, so the manifest records the submission URL and the build
// re-reads it: a pack whose page stops saying CC0, or starts also saying
// CC-BY, stops being fetchable here rather than quietly changing licence
// underneath us.
async function fetchOpenGameArt(src) {
  if (existsSync(join(sourcesDir, src.dir))) return;
  console.log(`fetching ${src.title} ...`);
  const res = await fetch(src.url);
  if (!res.ok) fail(`${src.url} answered ${res.status}; cannot confirm the licence, so not fetching`);
  const page = await res.text();
  const cc0 = (page.match(/publicdomain\/zero\/1\.0/g) || []).length;
  const ccby = (page.match(/licenses\/by(-sa|-nc|-nd)*\//g) || []).length;
  if (!cc0) fail(`${src.url} no longer states CC0; refusing to fetch it`);
  if (ccby) fail(`${src.url} now also carries a CC-BY style licence; refusing (attribution obligations are not silently taken on)`);
  if (!page.includes(src.zip)) fail(`${src.url} no longer links ${src.zip}`);
  const zipRes = await fetch(src.zip);
  if (!zipRes.ok) fail(`${src.zip} answered ${zipRes.status}`);
  const dest = join(sourcesDir, src.slug);
  mkdirSync(dest, { recursive: true });
  const zipPath = join(sourcesDir, `${src.slug}.zip`);
  writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest]);
}

if (doFetch) {
  for (const src of Object.values(manifest.sources)) {
    if (src.kind === 'kenney') await fetchKenney(src);
    if (src.kind === 'opengameart') await fetchOpenGameArt(src);
  }
}

// ── Build ───────────────────────────────────────────────────────────────────
const cues = Object.entries(manifest.cues).filter(([name]) => !only || only.includes(name));
const buildable = cues.filter(([, c]) => !c.placeholder);
if (buildable.length && !hasFfmpeg()) fail('ffmpeg is required (brew install ffmpeg)');
mkdirSync(outDir, { recursive: true });

// `integratedLufs` is kept in the manifest for the record and is no longer applied:
// see the level block below for why EBU R128 does not fit a one-shot library.
const tp = manifest.loudness?.truePeakDb ?? -1;
const credits = [];
let built = 0;

for (const [name, cue] of cues) {
  if (cue.placeholder) {
    if (!cue.fallback) fail(`placeholder cue '${name}' names no legacy fallback recipe`);
    continue;
  }
  const layers = cue.layers || [];
  if (!layers.length) fail(`cue '${name}' has no layers`);

  const inputs = [];
  const filters = [];
  const mixInputs = [];
  layers.forEach((layer, i) => {
    const srcKey = layer.source || cue.source;
    const src = manifest.sources[srcKey];
    if (!src) fail(`cue '${name}' layer ${i} names unknown source '${srcKey}'`);

    // A SYNTHESISED layer has no file on disk: ffmpeg generates it from the
    // `lavfi` expression, and that expression IS its provenance - the cue is
    // reproducible from this repo alone, with nothing to download and nobody
    // to credit but ourselves. Anything else is a sample from a licensed pack.
    let creditFile;
    if (src.kind === 'synth') {
      if (!layer.lavfi) fail(`cue '${name}' layer ${i} uses the synth source but names no lavfi expression`);
      inputs.push('-f', 'lavfi', '-i', layer.lavfi);
      creditFile = layer.lavfi;
    } else {
      const file = join(sourcesDir, src.dir, layer.file);
      if (!existsSync(file)) fail(`cue '${name}': missing source file ${file} (run with --fetch, or --sources <dir>)`);
      inputs.push('-i', file);
      creditFile = layer.file;
    }

    const delayMs = Math.round((layer.at || 0) * 1000);
    const gain = layer.gain ?? 1;
    // Optional per-layer shaping (a filter chain applied before the delay), so
    // a raw noise or sine source can be band-limited into the cue it is for.
    const shape = layer.filter ? `,${layer.filter}` : '';
    // mono, resample, shape, per-layer delay and gain
    filters.push(`[${i}:a]aformat=channel_layouts=mono,aresample=48000${shape},adelay=${delayMs}|${delayMs},volume=${gain}[l${i}]`);
    mixInputs.push(`[l${i}]`);
    credits.push({ cue: name, source: src, file: creditFile });
  });
  const mix =
    layers.length === 1
      ? `${mixInputs[0]}anull[mix]`
      : `${mixInputs.join('')}amix=inputs=${layers.length}:normalize=0:dropout_transition=0[mix]`;
  const trim = cue.trimEnd ? `,atrim=0:${cue.trimEnd}` : '';
  const head = `${filters.join(';')};${mix};[mix]${trim ? trim.slice(1) + ',' : ''}`;

  // ── LEVEL: measured peak normalisation, plus an INTENTIONAL per-cue offset.
  //
  // This used to be an EBU R128 normaliser, and that was the wrong tool for
  // this material. EBU R128 integrated loudness is defined over 400 ms blocks
  // with gating and needs SECONDS of programme to mean anything; every cue in
  // this library is a one-shot under three seconds. With nothing to measure,
  // that filter runs in dynamic mode and rides the level as it goes, which on a
  // 0.2 s transient surrounded by silence ducked `flute_clink_soft` to a
  // -36 dBFS peak - a cue that plays and nobody hears. Its own source peaks at
  // -0.8, so nothing was wrong with the sample.
  //
  // So: measure the peak of the assembled mix, then apply ONE static gain that
  // puts it at the true-peak target, offset by the cue's own `levelDb`. The
  // dynamics between cues are now something the manifest STATES - the cork pop
  // is the loudest thing in the library, the drips are 12 dB down - rather
  // than whatever a gate happened to do.
  const levelDb = cue.levelDb ?? 0;
  const measure = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-v', 'info', ...inputs, '-filter_complex', `${head}volumedetect[out]`,
      '-map', '[out]', '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  const mm = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(`${measure.stderr || ''}`);
  // "I could not measure it" is its own outcome and must not be folded into
  // "no gain needed" (CLAUDE.md 10.86 rule 1) - that would ship the cue at
  // whatever level it happened to have. Refuse instead.
  if (!mm) fail(`cue '${name}': could not measure the assembled mix, so its level cannot be set`);
  const mixPeak = Number(mm[1]);
  const gainDb = (tp + levelDb - mixPeak).toFixed(2);
  // `level=disabled` matters: alimiter auto-levels its output UP to the limit
  // by default, which would drag every cue back to the ceiling and undo the
  // levelDb offsets above. It is here only as a ceiling, never as a gain.
  const ceiling = Math.pow(10, tp / 20).toFixed(4);
  const chain = `${head}volume=${gainDb}dB,alimiter=limit=${ceiling}:level=disabled,aresample=48000[out]`;

  const webm = join(outDir, `${name}.webm`);
  const m4a = join(outDir, `${name}.m4a`);
  const common = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', chain, '-map', '[out]', '-ac', '1'];
  execFileSync('ffmpeg', [...common, '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', webm]);
  execFileSync('ffmpeg', [...common, '-c:a', 'aac', '-b:a', '96k', m4a]);

  // ── THE LEVEL GATE ───────────────────────────────────────────────────────
  // A cue that builds is not a cue anybody can hear. `flute_clink_soft` shipped
  // at a -36 dBFS peak while every other cue sat between -1.8 and -19: single
  // pass loudness normalisation ran in DYNAMIC mode, and on a transient surrounded
  // by silence it ducks by tens of dB. Nothing caught it, because every test
  // there is asks whether the FILE exists and is over 256 bytes - which a
  // silent file also is. Measure the bytes we just wrote, and refuse.
  const peak = peakDbOf(webm);
  if (peak === null) {
    fail(`cue '${name}': could not measure the output level, so it is not shippable`);
  }
  if (peak < QUIET_FLOOR_DB) {
    fail(
      `cue '${name}': peaks at ${peak.toFixed(1)} dBFS, below the ${QUIET_FLOOR_DB} dBFS floor - ` +
        `it would play and nobody would hear it. Raise the cue's "levelDb", or its layer gains.`
    );
  }

  built += 1;
  console.log(
    `built ${name} (${layers.length} layer${layers.length === 1 ? '' : 's'}, peak ${peak.toFixed(1)} dBFS)`
  );
}

// ── CREDITS.md: even CC0 gets a line. Somebody will ask. ────────────────────
const bySource = new Map();
for (const c of credits) {
  const k = c.source.title;
  if (!bySource.has(k)) bySource.set(k, { source: c.source, cues: new Map() });
  const entry = bySource.get(k);
  if (!entry.cues.has(c.cue)) entry.cues.set(c.cue, new Set());
  entry.cues.get(c.cue).add(c.file);
}
const lines = [
  '# Throwable sound cues: sources and licences',
  '',
  'Generated by `scripts/audio/build-throwable-cues.mjs` from `scripts/audio/throwable-cues.manifest.json`. Do not edit by hand.',
  '',
  `Level: each cue's assembled mix is measured and peak-normalised to ${tp} dBFS, ` +
    `offset by its own \`levelDb\` in the manifest (the cork pop is the loudest thing here; ` +
    `the drips sit 12-14 dB down). EBU R128 loudness is NOT used: every cue is a one-shot ` +
    `under three seconds, which is shorter than integrated loudness can measure. ` +
    `Containers: Opus (.webm) and AAC (.m4a).`,
  '',
];
for (const { source, cues: cueMap } of bySource.values()) {
  lines.push(
    `## ${source.title}`,
    '',
    `- Author: ${source.author}`,
    `- Licence: ${source.license}`,
    source.kind === 'synth'
      ? `- Generated: ${source.recipe}`
      : `- URL: ${source.url}`,
    '',
    source.kind === 'synth' ? '| Cue | ffmpeg source expression |' : '| Cue | Source file(s) |',
    '| --- | --- |'
  );
  for (const [cue, files] of cueMap) lines.push(`| \`${cue}\` | ${[...files].map((f) => `\`${f}\``).join(', ')} |`);
  lines.push('');
}
const placeholders = Object.entries(manifest.cues).filter(([, c]) => c.placeholder);
if (placeholders.length) {
  lines.push('## Placeholders (no file yet; the legacy procedural recipe plays instead)', '', '| Cue | Fallback recipe | Needed from |', '| --- | --- | --- |');
  for (const [name, c] of placeholders) lines.push(`| \`${name}\` | \`${c.fallback}\` | ${(c.$comment || '').replace(/\|/g, '/')} |`);
  lines.push('');
}
writeFileSync(join(outDir, 'CREDITS.md'), lines.join('\n'));

// ── The client's view ───────────────────────────────────────────────────────
const entries = Object.entries(manifest.cues).map(([name, c]) => {
  if (c.placeholder) return `  ${JSON.stringify(name)}: { placeholder: true, fallback: ${JSON.stringify(c.fallback)} },`;
  const srcKey = c.source;
  return `  ${JSON.stringify(name)}: { placeholder: false, license: ${JSON.stringify(manifest.sources[srcKey].license)} },`;
});
const ts = `/* GENERATED by scripts/audio/build-throwable-cues.mjs from throwable-cues.manifest.json. DO NOT EDIT. */

export interface CueManifestEntry {
  /** True when no file ships yet and \`fallback\` (a legacy recipe key) plays instead. */
  placeholder: boolean;
  fallback?: string;
  license?: string;
}

export const THROWABLE_CUE_MANIFEST: Record<string, CueManifestEntry> = {
${entries.join('\n')}
};

export const THROWABLE_CUE_ALLOWED_LICENSES: readonly string[] = ${JSON.stringify(manifest.allowedLicenses)};
`;
writeFileSync(generatedPath, ts);

console.log(`\n${built} cue(s) built, ${placeholders.length} placeholder(s) recorded, credits and manifest written.`);
