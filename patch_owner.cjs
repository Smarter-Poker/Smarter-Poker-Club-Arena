const fs = require('fs');
const file = 'src/components/wallet/DynamicWallet.tsx';
let content = fs.readFileSync(file, 'utf8');

const regex = /owner: \[[^\]]*\],/m;

const newOwner = `owner: [
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
    ],`;

content = content.replace(regex, newOwner);
fs.writeFileSync(file, content);
