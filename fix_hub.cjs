const fs = require('fs');
const file = '/Users/smarter.poker/Documents/.agent-trees/Smarter-Poker-World-Hub/antigravity-ads/src/components/ads/HubPromoRail.jsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
    'logDismiss({ adId }, SLOT);',
    'logDismiss(adId, SLOT);'
);

content = content.replace(
    'onClick={() => logClick({ adId: ad.adId }, SLOT)}',
    'onClick={() => logClick(ad.adId, SLOT)}'
);

fs.writeFileSync(file, content);
