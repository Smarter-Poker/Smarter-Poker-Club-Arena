const fs = require('fs');
const file = 'tests/e2e/live-animations.spec.ts';
let content = fs.readFileSync(file, 'utf8');

// Replace swWinFlash with swNeonHalo in the test
content = content.replace(
  /expect\(result\.swWinFlash, 'the winning segment must flash'\)\.toBe\(500\);/g,
  `expect(result.swNeonHalo, 'the winning segment must pulse a halo').toBe(600);`
);

fs.writeFileSync(file, content);
