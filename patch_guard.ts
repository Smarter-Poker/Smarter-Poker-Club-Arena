import fs from 'fs';

const path = 'src/components/auth/ClubMemberGuard.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(/console\.error\([^;]+\); /g, '');

fs.writeFileSync(path, code);
