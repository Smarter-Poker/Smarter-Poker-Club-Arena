const fs = require('fs');
const sql = fs.readFileSync('sql_escaped.txt', 'utf8').trim();
console.log(`
const editor = monaco.editor.getModels()[0];
editor.setValue(${sql});
`);
