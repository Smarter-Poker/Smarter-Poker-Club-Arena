import fs from 'fs';
const content = fs.readFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', 'utf8');

const target = `expect(src).toMatch(/\\.not('status', 'in', \\['closed', 'deleted'\\])/);`;
const replacement = `expect(src).toMatch(/\\.not\\('status',\\s*'in',\\s*\\[\\s*'closed',\\s*'deleted'\\s*\\]\\)/);`;

if (content.includes(target)) {
  fs.writeFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', content.replace(target, replacement));
  console.log('Fixed test');
} else {
  console.log('Target not found');
}
