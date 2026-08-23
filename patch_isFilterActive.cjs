const fs = require('fs');
const file = 'src/components/lobby/advancedFilterSpec.ts';
let code = fs.readFileSync(file, 'utf8');

const oldCheck = `    v.hide.length > 0 ||
    v.rangeMin !== spec.range.min ||`;

const newCheck = `    v.hide.length > 0 ||
    (v.selectedRanges && v.selectedRanges.length > 0) ||
    v.rangeMin !== spec.range.min ||`;

code = code.replace(oldCheck, newCheck);

fs.writeFileSync(file, code);
console.log('isFilterActive patched');
