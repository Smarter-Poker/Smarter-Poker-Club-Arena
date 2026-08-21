const fs = require('fs');
const file = 'src/components/wallet/DynamicWallet.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add canMint to WalletRow type
content = content.replace(
  /type WalletRow = \{[\s\S]*?known\?: boolean;\n  \};/,
  `type WalletRow = {\n    label: string;\n    icon: WalletIconName;\n    value: number;\n    hint?: string;\n    known?: boolean;\n    canMint?: boolean;\n  };`
);

// 2. Update owner variant
content = content.replace(
  /owner: \[\s*\{\s*label: 'Player Wallet',[\s\S]*?\},[\s\S]*?\{ label: 'Promo Wallet', icon: 'promo', value: animRow3 \},\s*\],/,
  `owner: [
      {
        label: 'Player Wallet',
        icon: 'chip',
        value: animPlayerWallet,
        hint: 'The Wallet You Play From',
      },
      { 
        label: isClubInUnion ? 'Union Wallet' : 'Club Bank', 
        icon: 'bank', 
        value: animRow1,
        canMint: true 
      },
      ...(isClubInUnion ? [{
        label: 'Rake Wallet',
        icon: 'treasury' as WalletIconName,
        value: animTreasury,
        hint: 'Held In Trust'
      }] : []),
      { label: 'Agent Wallet', icon: 'agent', value: animRow2 },
      { label: 'Promo Wallet', icon: 'promo', value: animRow3 },
    ],`
);

// 3. Update union variant
content = content.replace(
  /union: \[\s*\{\s*label: 'Union Bank',\s*icon: 'bank',\s*value: animRow1,/g,
  `union: [
      {
        label: 'Union Bank',
        icon: 'bank',
        value: animRow1,
        canMint: true,`
);

// 4. Update JSX to check row.canMint instead of idx === 0
content = content.replace(
  /\{idx === 0 && showMintButton && \(/g,
  `{row.canMint && showMintButton && (`
);

fs.writeFileSync(file, content);
