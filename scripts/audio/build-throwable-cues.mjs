#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUILD THE THROWABLE CUES (phase 1, 2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reads scripts/audio/throwable-cues.manifest.json and, for every cue that is
 * not a placeholder, layers its source files with ffmpeg (adelay + amix),
 * trims, loudness-normalises (EBU R128 loudnorm to the manifest's target,
 * -16 LUFS / -1 dBTP by default), and writes
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

if (doFetch) {
  for (const src of Object.values(manifest.sources)) {
    if (src.kind === 'kenney') await fetchKenney(src);
  }
}

// ── Build ───────────────────────────────────────────────────────────────────
const cues = Object.entries(manifest.cues).filter(([name]) => !only || only.includes(name));
const buildable = cues.filter(([, c]) => !c.placeholder);
if (buildable.length && !hasFfmpeg()) fail('ffmpeg is required (brew install ffmpeg)');
mkdirSync(outDir, { recursive: true });

const lufs = manifest.loudness?.integratedLufs ?? -16;
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
  const chain = `${filters.join(';')};${mix};[mix]${trim ? trim.slice(1) + ',' : ''}loudnorm=I=${lufs}:TP=${tp}:LRA=11,aresample=48000[out]`;

  const webm = join(outDir, `${name}.webm`);
  const m4a = join(outDir, `${name}.m4a`);
  const common = ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', chain, '-map', '[out]', '-ac', '1'];
  execFileSync('ffmpeg', [...common, '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', webm]);
  execFileSync('ffmpeg', [...common, '-c:a', 'aac', '-b:a', '96k', m4a]);
  built += 1;
  console.log(`built ${name} (${layers.length} layer${layers.length === 1 ? '' : 's'})`);
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
  `Loudness target: ${lufs} LUFS integrated, ${tp} dBTP. Containers: Opus (.webm) and AAC (.m4a).`,
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
