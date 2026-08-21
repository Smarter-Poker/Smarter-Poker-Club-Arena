const fs = require('fs');
const file = 'src/components/wallet/DynamicWallet.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /const animTreasury = useAnimatedCounter\(\n    effectiveVariant === 'union' \? data.unionRake : data.clubTreasury\n  \);/g,
  `const animTreasury = useAnimatedCounter(
    (effectiveVariant === 'union' || (effectiveVariant === 'owner' && isClubInUnion)) ? data.unionRake : data.clubTreasury
  );`
);

fs.writeFileSync(file, content);
