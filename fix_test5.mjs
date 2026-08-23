import fs from 'fs';
let content = fs.readFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', 'utf8');

content = content.replace(
  /expect\(src\)\.toMatch\(\/\\.*?\/\);/g,
  `expect(src).toMatch(/\\.not\\('status',\\s*'in',\\s*\\[\\s*'closed',\\s*'deleted'\\s*\\]\\)/);`
);
fs.writeFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', content);
