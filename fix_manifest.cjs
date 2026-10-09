const fs = require('fs');
const crypto = require('crypto');

const manifestPath = 'scripts/qualification/cash-native-hosted.manifest.json';
const ciPath = '.github/workflows/ci.yml';

const manifestStr = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestStr);

const ciStats = fs.statSync(ciPath);
const ciContent = fs.readFileSync(ciPath);
const hash = crypto.createHash('sha256').update(ciContent).digest('hex');

if (manifest.files && manifest.files['.github/workflows/ci.yml']) {
    manifest.files['.github/workflows/ci.yml'].bytes = ciStats.size;
    manifest.files['.github/workflows/ci.yml'].sha256 = hash;
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
