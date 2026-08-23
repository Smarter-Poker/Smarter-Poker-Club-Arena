const fs = require('fs');
const file = 'src/components/wallet/DynamicWallet.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /<<<<<<< HEAD\n\s*\{\(effectiveVariant === 'union' \|\| \(\!isClubInUnion && data\.backupBBJ > 0\)\) && \(\n=======\n\s*\{\(effectiveVariant === 'union' \|\|\n\s*\(effectiveVariant === 'owner' && isClubInUnion\) \|\|\n\s*\(\!isClubInUnion && data\.backupBBJ > 0\)\) && \(\n>>>>>>> 27b3dcfd0 \(fix\(wallet\): revamp owner panel for unions and sum BBJ pools\)/,
  `{(effectiveVariant === 'union' ||
          (effectiveVariant === 'owner' && isClubInUnion) ||
          (!isClubInUnion && data.backupBBJ > 0)) && (`
);

fs.writeFileSync(file, content);
