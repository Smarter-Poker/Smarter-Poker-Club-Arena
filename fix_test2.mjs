import fs from 'fs';
const src = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

const regex = /\.not\('status', 'in', \['closed', 'deleted'\]\)/;
console.log('Match:', regex.test(src));

const regex2 = /\.not\('status', 'in', \['closed', 'deleted'\]\)/;

