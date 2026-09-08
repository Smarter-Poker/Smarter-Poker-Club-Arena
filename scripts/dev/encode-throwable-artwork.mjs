import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const source = path.resolve('art-source/animated');
const output = path.resolve('public/images/throwables/animated');
fs.mkdirSync(output, { recursive: true });
const results = [];
for (const file of fs
  .readdirSync(source)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const input = path.join(source, file);
  const target = path.join(output, file.replace(/\.png$/, '.webp'));
  await sharp(input).webp({ lossless: true, effort: 6, alphaQuality: 100 }).toFile(target);
  const a = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(target).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (
    a.info.width !== b.info.width ||
    a.info.height !== b.info.height ||
    a.data.length !== b.data.length
  ) {
    throw new Error(`${file}: lossless encoding changed dimensions`);
  }
  for (let i = 0; i < a.data.length; i += 4) {
    // RGB under fully transparent pixels has no visual meaning. Everything
    // visible, including partially transparent edges, must match exactly.
    if (
      a.data[i + 3] !== b.data[i + 3] ||
      (a.data[i + 3] &&
        (a.data[i] !== b.data[i] ||
          a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]))
    ) {
      throw new Error(`${file}: visible pixels changed at ${i / 4}`);
    }
  }
  results.push({
    file,
    width: a.info.width,
    height: a.info.height,
    sourceBytes: fs.statSync(input).size,
    runtimeBytes: fs.statSync(target).size,
    visiblePixelsIdentical: true,
  });
}
fs.writeFileSync(
  path.join(source, 'encoding-report.json'),
  JSON.stringify(results, null, 2) + '\n'
);
const before = results.reduce((n, r) => n + r.sourceBytes, 0);
const after = results.reduce((n, r) => n + r.runtimeBytes, 0);
console.log(
  `${results.length} lossless atlases: ${before} -> ${after} bytes (${(100 * (1 - after / before)).toFixed(1)}% smaller).`
);
