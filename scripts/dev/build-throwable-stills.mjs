import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

// Delivery thumbnails of the already approved source artwork. The original
// pixels remain outside public assets; runtime transparency uses ThrowableCutout.
const source = path.resolve('art-source/static');
const output = path.resolve('public/images/throwables/stylized');
fs.mkdirSync(output, { recursive: true });
const manifest = {};
const report = [];
for (const file of fs
  .readdirSync(source)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const id = file.slice(0, -4);
  const sourceMetadata = await sharp(path.join(source, file)).metadata();
  if (sourceMetadata.width !== sourceMetadata.height || sourceMetadata.width < 640)
    throw new Error(`${file}: approved delivery artwork must be square and at least 640px`);
  manifest[id] = {};
  for (const bucket of [192, 320, 640]) {
    const bytes = await sharp(path.join(source, file))
      .resize(bucket, bucket, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92, effort: 5 })
      .toBuffer();
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const filename = `${id}-${bucket}-${digest.slice(0, 12)}.webp`;
    fs.writeFileSync(path.join(output, filename), bytes);
    manifest[id][bucket] = `images/throwables/stylized/${filename}`;
    const metadata = await sharp(bytes).metadata();
    report.push({
      id,
      bucket,
      filename,
      bytes: bytes.length,
      width: metadata.width,
      height: metadata.height,
      sha256: digest,
    });
  }
}
fs.writeFileSync('src/throwables/stills.generated.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('art-source/static/delivery-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  `${Object.keys(manifest).length} approved stills, ${report.length} thumbnails, ${report.reduce((s, x) => s + x.bytes, 0)} bytes.`
);
