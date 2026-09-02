/**
 * A minimal PNG reader for asset guards.
 *
 * The table-skin tests have to look at actual pixels, and a test may not add a
 * dependency to do it. Node ships `zlib`, and un-filtering the scanlines is
 * about sixty lines (PNG spec 9.2), so this is the whole cost of reading an
 * asset in CI.
 *
 * Deliberately narrow: 8-bit RGBA, non-interlaced, which is what every skin in
 * src/assets/tables is. Anything else throws rather than guessing — an asset
 * that is not in that format is itself worth knowing about.
 */
import zlib from 'zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, width * height * 4 */
  pixels: Buffer;
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${bitDepth}, colorType ${colorType}, interlace ${interlace}`
    );
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
  }

  return { width, height, pixels: out };
}

/** Rec. 601 luminance of one pixel. */
export function luminanceAt(img: DecodedPng, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.pixels[i] + 0.587 * img.pixels[i + 1] + 0.114 * img.pixels[i + 2];
}

/** Alpha of one pixel. */
export function alphaAt(img: DecodedPng, x: number, y: number): number {
  return img.pixels[(y * img.width + x) * 4 + 3];
}
