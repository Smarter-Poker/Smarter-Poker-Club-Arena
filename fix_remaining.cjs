const fs = require('fs');

function fix(file) {
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(/#fbbf24/gi, '#6fdcff');
  code = code.replace(/#f59e0b/gi, '#0a5dc2');
  code = code.replace(/#f97316/gi, '#1877f2');
  code = code.replace(/#ffd700/gi, '#6fdcff');
  code = code.replace(/#fff2a8/gi, '#e8eaf0');
  fs.writeFileSync(file, code);
}

fix('src/components/tournament/SpinWheel.css');
fix('src/components/tournament/MysteryBountyChest.css');
console.log('Fixed remainders.');
