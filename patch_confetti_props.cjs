const fs = require('fs');
const file = '/tmp/CA/src/components/effects/ConfettiEffect.tsx';
let content = fs.readFileSync(file, 'utf8');

const targetProps = `interface ConfettiEffectProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy';
  colors?: string[];
  duration?: number;
}`;

const replaceProps = `interface ConfettiEffectProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy' | 'jackpot';
  colors?: string[];
  duration?: number;
}`;

content = content.replace(targetProps, replaceProps);

const targetCount = `const particleCount = intensity === 'light' ? 30 : intensity === 'heavy' ? 100 : 50;`;
const replaceCount = `const particleCount = intensity === 'light' ? 30 : intensity === 'heavy' ? 100 : intensity === 'jackpot' ? 300 : 50;`;

content = content.replace(targetCount, replaceCount);

fs.writeFileSync(file, content, 'utf8');
