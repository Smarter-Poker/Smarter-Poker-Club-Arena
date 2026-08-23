const fs = require('fs');
const path = require('path');

const dirs = [
  'src/components/tournament',
  'src/pages/tournament'
];

function processDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.css') || fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      let code = fs.readFileSync(fullPath, 'utf8');
      
      // Strict replacements (NO YELLOW, NO BROWN, NO GOLD, NO PURPLE, NO MINT)
      code = code.replace(/#fbbf24/gi, '#6fdcff'); // Gold/Amber to Cyan
      code = code.replace(/#f59e0b/gi, '#0a5dc2'); // Amber to Blue
      code = code.replace(/#f97316/gi, '#1877f2'); // Orange to Blue
      code = code.replace(/#ffd700/gi, '#6fdcff'); // Gold to Cyan
      code = code.replace(/#ffc107/gi, '#00b4e6'); // Amber to Cyan
      code = code.replace(/#ffb300/gi, '#0a5dc2');
      code = code.replace(/#ff8f00/gi, '#1877f2');
      code = code.replace(/#ffecb3/gi, '#e8eaf0'); // Light yellow to text primary
      code = code.replace(/var\(--accent-gold\)/g, '#6fdcff');
      code = code.replace(/var\(--accent-orange\)/g, '#00b4e6');
      code = code.replace(/rgba\(255,\s*215,\s*0/gi, 'rgba(111, 220, 255'); // Gold rgba to Cyan rgba
      code = code.replace(/rgba\(251,\s*191,\s*36/gi, 'rgba(111, 220, 255');
      code = code.replace(/#a78bfa/gi, '#6fdcff'); // Purple to Cyan
      code = code.replace(/#34d399/gi, '#6fdcff'); // Mint to Cyan
      
      // Some explicit brown/bronze in TournamentDetails.css
      code = code.replace(/rgba\(205,\s*127,\s*50/gi, 'rgba(10, 93, 194'); // Bronze to Blue
      
      fs.writeFileSync(fullPath, code);
    }
  }
}

dirs.forEach(processDir);
console.log('Done replacing colors.');
