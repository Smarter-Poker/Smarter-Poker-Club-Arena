const fs = require('fs');
const file = 'src/components/wallet/DynamicWallet.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /\{\(effectiveVariant === 'union' \|\| \(\!isClubInUnion && data.backupBBJ > 0\)\) && \(/g,
  `{(effectiveVariant === 'union' || (effectiveVariant === 'owner' && isClubInUnion) || (!isClubInUnion && data.backupBBJ > 0)) && (`
);

fs.writeFileSync(file, content);
