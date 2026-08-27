const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
require('dotenv').config({ path: '../../.env' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const mapping = {
  'media_1787786158217.png': 'icon-addscreen',
  'media_1787786164927.jpg': 'icon-hamburger',
  'media_1787786166898.jpg': 'icon-prevhand',
  'media_1787786169398.jpg': 'icon-rabbit',
  'media_1787786171483.jpg': 'icon-stats',
  'media_1787786269213.jpg': 'icon-timebank',
  'media_1787786390160.jpg': 'icon-chat',
};

const inputDir = '/Users/smarter.poker/.gemini/antigravity/brain/48ce3dd0-c827-4808-9f9b-bcabfe738098/.user_uploaded/';

async function run() {
  for (const [filename, iconName] of Object.entries(mapping)) {
    const inputPath = path.join(inputDir, filename);
    console.log(`Processing ${iconName}...`);
    
    // Process black
    const blackBuffer = await sharp(inputPath)
      .resize(256, 256)
      .webp({ quality: 90 })
      .toBuffer();
      
    // Process blue
    const blueBuffer = await sharp(inputPath)
      .resize(256, 256)
      .tint({ r: 50, g: 120, b: 255 })
      .webp({ quality: 90 })
      .toBuffer();

    console.log(`Uploading ${iconName} (black)...`);
    const resBlack = await supabase.storage.from('assets').upload(`buttons/black/${iconName}.webp`, blackBuffer, {
      contentType: 'image/webp',
      upsert: true,
    });
    if (resBlack.error) console.error(resBlack.error);

    console.log(`Uploading ${iconName} (blue)...`);
    const resBlue = await supabase.storage.from('assets').upload(`buttons/blue/${iconName}.webp`, blueBuffer, {
      contentType: 'image/webp',
      upsert: true,
    });
    if (resBlue.error) console.error(resBlue.error);
  }
  console.log('Upload complete.');
}

run();
