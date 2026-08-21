const fs = require('fs');
const file = '/tmp/CA/src/pages/DailyChallengesPage.tsx';
let content = fs.readFileSync(file, 'utf8');

const target = `          <ConfettiEffect
            isActive={true}
            intensity="heavy"
            colors={['#00f0ff', '#0ff', '#ffffff']}
            duration={4000}
          />`;

const replace = `          {challenges.filter(c => c.tier === 'daily').every(c => c.completed) ? (
            <ConfettiEffect
              isActive={true}
              intensity="jackpot"
              colors={['#f59e0b', '#fbbf24', '#ffffff', '#00f0ff']}
              duration={8000}
            />
          ) : (
            <ConfettiEffect
              isActive={true}
              intensity="heavy"
              colors={['#00f0ff', '#0ff', '#ffffff']}
              duration={4000}
            />
          )}`;
content = content.replace(target, replace);
fs.writeFileSync(file, content, 'utf8');
