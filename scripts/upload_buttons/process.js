const sharp = require('sharp');
const path = require('path');

const file = '/Users/smarter.poker/.gemini/antigravity/brain/48ce3dd0-c827-4808-9f9b-bcabfe738098/.user_uploaded/media_1787786164927.jpg';

async function test() {
  await sharp(file)
    .resize(256, 256)
    .webp({ quality: 90 })
    .toFile('test-black.webp');

  await sharp(file)
    .resize(256, 256)
    .tint({ r: 50, g: 120, b: 255 })
    .webp({ quality: 90 })
    .toFile('test-blue.webp');

  console.log('Done');
}
test();
