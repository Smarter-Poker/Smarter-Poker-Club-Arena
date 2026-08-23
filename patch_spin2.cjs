const fs = require('fs');
const file = 'tests/e2e/live-animations.spec.ts';
let content = fs.readFileSync(file, 'utf8');

// Remove the expectation for the deleted animation
content = content.replace(
  /expect\(result\.swNeonHalo, 'the winning segment must pulse a halo'\)\.toBe\(600\);\n\s*/g,
  ''
);

fs.writeFileSync(file, content);
