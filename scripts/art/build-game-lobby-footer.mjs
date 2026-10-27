/** Rebuild the approved October 27 Game Lobby cell, retaining all other master pixels.
 * Sources are the approved option 3 doors (imagegen alpha extraction) and its
 * feathered quilt fill. New filenames preserve cached footer asset immutability.
 */
import sharp from 'sharp';
const root = 'public/images/club-footer/';
const text = Buffer.from(
  '<svg width="240" height="40"><text x="120" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" fill="#f4f4f4">GAME LOBBY</text></svg>'
);
for (const [input, output, center] of [
  ['club-arena-footer-v3.webp', 'club-arena-footer-v4.webp', 1138],
  ['club-arena-footer-player-v1.webp', 'club-arena-footer-player-v2.webp', 1310],
  ['club-arena-footer-mobile-v1.webp', 'club-arena-footer-mobile-v2.webp', 907],
]) {
  await sharp(root + input)
    .composite([
      { input: root + 'source/game-lobby-v1/texture.png', left: center - 120, top: 35 },
      { input: root + 'source/game-lobby-v1/doors.png', left: center - 74, top: 39 },
      { input: text, left: center - 120, top: 177 },
    ])
    .webp({ lossless: true })
    .toFile(root + output);
}
