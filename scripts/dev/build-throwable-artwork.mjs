import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Metadata only: source pixels are never altered by this generator.
const root = process.cwd();
const rigs = {};
const sizes = {};
const hashes = {};
for (const file of fs.readdirSync(path.join(root, 'src/throwables/rigs')).sort()) {
  if (!file.endsWith('.tsx')) continue;
  const code = fs.readFileSync(path.join(root, 'src/throwables/rigs', file), 'utf8');
  if (/\bsrc=\{/.test(code))
    throw new Error(`${file}: declare literal atlas names so readiness can be verified`);
  const names = [...new Set([...code.matchAll(/src="([a-z0-9_-]+)"/g)].map((m) => m[1]))].sort();
  rigs[file.slice(0, -4)] = names;
  for (const name of names) {
    const data = fs.readFileSync(path.join(root, 'art-source/animated', `${name}.png`));
    if (
      data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      data.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error(`${name}: expected a PNG with an IHDR header`);
    }
    sizes[name] = [data.readUInt32BE(16), data.readUInt32BE(20)];
    hashes[name] = createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'public/images/throwables/animated', `${name}.webp`)))
      .digest('hex')
      .slice(0, 16);
  }
}
fs.writeFileSync(
  path.join(root, 'src/throwables/artwork.generated.json'),
  JSON.stringify({ rigs, sizes, hashes }, null, 2) + '\n'
);
console.log(
  `Recorded ${Object.keys(rigs).length} rigs and ${Object.keys(sizes).length} atlas sizes.`
);
