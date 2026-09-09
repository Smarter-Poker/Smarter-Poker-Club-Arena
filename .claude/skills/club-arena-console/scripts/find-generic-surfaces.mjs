#!/usr/bin/env node
/**
 * #ClubArenaConsole - the inventory.
 *
 *   node .claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs [--json]
 *
 * Scores every page and modal in src/ for how far it is from the standard, so
 * a sweep is ordered by evidence instead of by whoever shouted loudest:
 *
 *   radius   CSS corner radii              (a rounded card is a drawn frame)
 *   grad     gradients + box-shadows       (paint the art does not need)
 *   master   references to club-buttons/   (art it already uses - lower is worse)
 *   hover    :hover rules                  (forbidden outright)
 *   px       px font sizes                 (should be cqw against the chassis)
 *
 * A surface with master:0 and a high radius+grad is "still generic".
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const count = (s, re) => (s.match(re) ?? []).length;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SRC).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
/* Read every file ONCE. Counting importers by re-reading the tree per surface
   is O(n^2) and takes minutes on this repo. */
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const rows = [];
for (const tsx of files) {
  const name = basename(tsx, '.tsx');
  const isSurface = /Page$|Modal$|Sheet$|Panel$|Overlay$|Dialog$|Banner$|Card$/.test(name);
  if (!isSurface) continue;
  const css = [join(dirname(tsx), `${name}.css`), join(dirname(tsx), `${name}.module.css`)]
    .find(existsSync);
  const src = sources.get(tsx);
  const style = css ? readFileSync(css, 'utf8') : '';
  const both = src + style;
  /* IS IT ALIVE? A stale clone keeps components main has deleted, and a
     redesign of one is a round spent on nothing. Anything with no importer is
     dead or an entry point; check `git cat-file -e origin/main:<path>` before
     you touch it. */
  const rel = tsx.slice(ROOT.length + 1);
  let importers = 0;
  for (const [f, text] of sources) {
    if (f !== tsx && (text.includes(`/${name}'`) || text.includes(`./${name}'`))) importers++;
  }
  const row = {
    file: rel,
    importers,
    css: css ? css.slice(ROOT.length + 1) : null,
    lines: src.split('\n').length,
    radius: count(style, /border-radius/g),
    grad: count(style, /linear-gradient|radial-gradient|box-shadow/g),
    master: count(both, /club-buttons/g),
    console: count(src, /SpadeConsole|PlateButton|ZoneText|sc-ink--/g),
    hover: count(style, /:hover/g),
    px: count(style, /font-size:\s*\d+(\.\d+)?px/g),
  };
  row.score = row.master + row.console > 0 ? 0 : row.radius * 2 + row.grad + row.hover * 5;
  rows.push(row);
}
rows.sort((a, b) => b.score - a.score || b.radius - a.radius);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('score  radius grad hover px  imp  file');
  for (const r of rows.filter((r) => r.score > 0)) {
    console.log(
      String(r.score).padStart(5),
      String(r.radius).padStart(6),
      String(r.grad).padStart(4),
      String(r.hover).padStart(5),
      String(r.px).padStart(3),
      String(r.importers).padStart(4),
      r.importers === 0 ? ' DEAD? ' : ' ',
      r.file
    );
  }
  const done = rows.filter((r) => r.score === 0);
  console.log(`\n${done.length} surface(s) already on the master, ${rows.length - done.length} to go.`);
}
