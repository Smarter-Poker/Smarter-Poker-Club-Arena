import fs from 'fs';
let content = fs.readFileSync('eslint.config.js', 'utf8');
content = content.replace(
  /\n\)/,
  `,\n  {\n    files: ['server/**/*.{ts,tsx}'],\n    rules: {\n      'no-restricted-imports': 'off'\n    }\n  }\n)`
);
fs.writeFileSync('eslint.config.js', content);
