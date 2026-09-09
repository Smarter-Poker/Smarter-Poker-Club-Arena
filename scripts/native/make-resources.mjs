#!/usr/bin/env node
/**
 * Build the two source images @capacitor/assets wants from the one logo the
 * app already ships (public/poker-chip-logo.png, 1024x1024):
 *
 *   resources/icon.png    1024x1024, opaque (iOS refuses alpha in an app icon)
 *   resources/splash.png  2732x2732, the logo centred on #0a0a1a
 *
 * Then `npm run cap:assets` writes every icon and splash size into ios/ and
 * android/. Re-run both when the logo changes; the outputs are committed so a
 * binary can be cut from a clean checkout without a design tool.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSharp } from '../lib/sharp-loader.mjs';

const root = resolve(import.meta.dirname, '../..');
const src = resolve(root, 'public/poker-chip-logo.png');
const out = resolve(root, 'resources');
const BG = '#0a0a1a';

const sharp = await loadSharp();
mkdirSync(out, { recursive: true });

await sharp(src)
  .resize(1024, 1024, { fit: 'cover' })
  .flatten({ background: BG })
  .png()
  .toFile(resolve(out, 'icon.png'));

// The splash is the logo at ~40% of the short side, so it survives the
// cropping every phone aspect ratio applies to a square source.
const logo = await sharp(src)
  .resize(1100, 1100, { fit: 'contain', background: BG })
  .png()
  .toBuffer();
await sharp({ create: { width: 2732, height: 2732, channels: 3, background: BG } })
  .composite([{ input: logo, gravity: 'centre' }])
  .png()
  .toFile(resolve(out, 'splash.png'));

console.log('wrote resources/icon.png (1024) and resources/splash.png (2732)');
