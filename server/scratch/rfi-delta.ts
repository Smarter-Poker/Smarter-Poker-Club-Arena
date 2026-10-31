import fs from 'node:fs';
const [offF, onF, key] = process.argv.slice(2);
const off = JSON.parse(fs.readFileSync(offF, 'utf8'))[key];
const on = JSON.parse(fs.readFileSync(onF, 'utf8'))[key];
for (const seat of Object.keys(on)) {
  const add: string[] = [];
  const drop: string[] = [];
  for (const cls of Object.keys(on[seat].cells)) {
    const a = off[seat].cells[cls].raise;
    const b = on[seat].cells[cls].raise;
    if (b - a >= 0.4) add.push(cls);
    if (a - b >= 0.4) drop.push(cls);
  }
  console.log(`${seat}: ${off[seat].rfi.toFixed(1)} -> ${on[seat].rfi.toFixed(1)} | now opens: ${add.join(' ') || '-'} | now folds: ${drop.join(' ') || '-'}`);
}
