const fs = require('fs');
const content = fs.readFileSync('tests/approvedHamburgerGearGuard.law.test.ts', 'utf8');
const maskCommentsDef = "\n/** Strip block and line comments so a prose mention of gear cannot fail us. */\nconst maskComments = (css: string) => css.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/^\\s*\\/\\/.*$/gm, '');\n";
const newContent = content.replace("const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');", "const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');\n" + maskCommentsDef);
fs.writeFileSync('tests/approvedHamburgerGearGuard.law.test.ts', newContent);
