const fs = require('fs');
const manifestPath = 'scripts/qualification/cash-native-hosted.manifest.json';
const manifestStr = fs.readFileSync(manifestPath, 'utf8');
const fixed = manifestStr.replace(/\\n$/, '\n');
fs.writeFileSync(manifestPath, fixed);
