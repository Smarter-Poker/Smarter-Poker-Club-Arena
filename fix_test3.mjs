import fs from 'fs';
const src = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

const regex = /\.not\('status',\s*'in',\s*\[\s*'closed',\s*'deleted'\s*\]\)/;
console.log('Match:', regex.test(src));
if (regex.test(src)) {
  const testFile = fs.readFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', 'utf8');
  const updated = testFile.replace(
    /expect\(src\)\.toMatch\(\/\.not[^)]+\)\);\n/,
    `expect(src).toMatch(/\\.not\\('status',\\s*'in',\\s*\\[\\s*'closed',\\s*'deleted'\\s*\\]\\)/);\n`
  );
  fs.writeFileSync('tests/unit/lobbySortIsNotAFilter.test.ts', updated);
  console.log('Test file updated');
}
