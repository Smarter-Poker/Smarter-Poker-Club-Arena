const fs = require('fs');
const path = require('path');

const dirs = [
  'src/components/tournament'
];

function processDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.css')) {
      let code = fs.readFileSync(fullPath, 'utf8');
      
      code = code.replace(/rgba\(36,\s*37,\s*38/gi, 'rgba(34, 48, 70');
      code = code.replace(/rgba\(58,\s*59,\s*60/gi, 'rgba(26, 36, 54');
      code = code.replace(/#242526/gi, '#1a2436');
      code = code.replace(/#3A3B3C/gi, '#223046');
      
      fs.writeFileSync(fullPath, code);
    }
  }
}

dirs.forEach(processDir);
console.log('Done replacing greys with navy surfaces.');
