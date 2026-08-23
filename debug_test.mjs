import { readFileSync } from 'fs';
const src = readFileSync('server/src/services/HorseOnboarding.ts', 'utf8');
const re = /\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,400}?\.(update|upsert|insert)\(/g;
let m;
while ((m = re.exec(src))) {
  console.log("MATCH FOUND!");
  const tail = src.slice(m.index, m.index + 600);
  console.log("TAIL:", tail);
  console.log("TEST:", /(?<!arena_)\bavatar_url\b\s*:/.test(tail));
}
