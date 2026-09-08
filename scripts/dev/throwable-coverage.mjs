import fs from 'node:fs';

// Inventory is deliberately independent of the currently enabled picker.
// A legacy alias must never make an unbuilt handoff item appear covered.
const read = (file) => fs.readFileSync(file, 'utf8');
const catalogue = JSON.parse(read('docs/throwables/COVERAGE-CATALOGUE.json'));
const ids = [...catalogue.original, ...catalogue.additional];
if (new Set(ids).size !== ids.length) throw new Error('Duplicate coverage ID');
const service = read('src/services/ThrowableService.ts');
const picker = new Set([...service.matchAll(/\bT\(\s*'([^']+)'/g)].map((m) => m[1]));
for (const id of picker) if (!ids.includes(id)) throw new Error(`Untracked picker item: ${id}`);
const registry = read('src/throwables/registry.ts');
const artwork = JSON.parse(read('src/throwables/artwork.generated.json'));
const stills = JSON.parse(read('src/throwables/stills.generated.json'));
const rows = ids.map((id) => {
  const rigFile = `src/throwables/rigs/${id}.tsx`;
  const hasSource = fs.existsSync(rigFile);
  const registered = new RegExp(`^\\s*${id}:\\s*\\{`, 'm').test(registry);
  const atlases = artwork.rigs[id] ?? [];
  const animation =
    registered &&
    hasSource &&
    atlases.length > 0 &&
    atlases.every((atlas) => fs.existsSync(`public/images/throwables/animated/${atlas}.webp`));
  const still = ['192', '320', '640'].every(
    (size) => stills[id]?.[size] && fs.existsSync(`public/${stills[id][size]}`)
  );
  return {
    id,
    picker: picker.has(id),
    still,
    animation,
    separateGlovePlayer: id === 'boxing_glove',
    acceptance: 'pending',
  };
});
const report = {
  total: ids.length,
  original: catalogue.original.length,
  additional: catalogue.additional.length,
  enabledPicker: rows.filter((r) => r.picker).length,
  premiumStills: rows.filter((r) => r.still).length,
  integratedAtlasRigs: rows.filter((r) => r.animation).length,
  note: 'Source inventory only. Glove uses a separate player. No row is fully accepted by file presence; sound, gates, multiplayer, device and publication need separate evidence.',
  missingAtlasRigs: rows.filter((r) => !r.animation && !r.separateGlovePlayer).map((r) => r.id),
  rows,
};
if (process.argv.includes('--write')) {
  fs.writeFileSync(
    'docs/throwables/COVERAGE.generated.json',
    JSON.stringify(report, null, 2) + '\n'
  );
}
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
