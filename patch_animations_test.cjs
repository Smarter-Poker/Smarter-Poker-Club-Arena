const fs = require('fs');
const file = 'tests/e2e/live-animations.spec.ts';
let content = fs.readFileSync(file, 'utf8');

// Fix the chest lid test
content = content.replace(
  /document\.getElementById\('mbc'\)!\.className = 'mbc mbc--locked';\n\s*await new Promise<void>\(\(r\) => requestAnimationFrame\(\(\) => r\(\)\)\);\n\s*document\.getElementById\('mbc'\)!\.className = 'mbc mbc--opening';/,
  `document.getElementById('mbc')!.className = 'mbc mbc--locked';
      window.getComputedStyle(el).transform; // Force layout flush
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); // Ensure next frame
      document.getElementById('mbc')!.className = 'mbc mbc--opening';`
);

// Fix the Spin wheel test (removed winner flash?)
// Wait, the commit removed the wash, halo, drain-to-grey. Is swWinFlash removed?
