import fs from 'fs';
let content = fs.readFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', 'utf8');

// The problematic line is:
// expect(src).toMatch(/\.not\('status', 'in', '\['closed', 'deleted'\]\)/);
content = content.replace(
  /expect\(src\)\.toMatch\(\/\\\.not[^;]+;\n/g,
  `expect(src).toMatch(/\\\\.not\\\\('status',\\\\s*'in',\\\\s*\\\\[\\\\s*'closed',\\\\s*'deleted'\\\\s*\\\\]\\\\)/);\n`
);
fs.writeFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', content);
