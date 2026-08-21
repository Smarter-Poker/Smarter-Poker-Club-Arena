const fs = require('fs');
const file = '/tmp/CA/src/components/effects/ConfettiEffect.tsx';
let content = fs.readFileSync(file, 'utf8');

const target = `export interface ConfettiProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy';
  colors?: string[];
  duration?: number;
}`;

const replace = `export interface ConfettiProps {
  isActive: boolean;
  intensity?: 'light' | 'medium' | 'heavy' | 'jackpot';
  colors?: string[];
  duration?: number;
}`;
content = content.replace(target, replace);

const amountTarget = `      switch (intensity) {
        case 'light':
          amount = 30;
          break;
        case 'heavy':
          amount = 150;
          break;
        case 'medium':
        default:
          amount = 80;
          break;
      }`;
      
const amountReplace = `      switch (intensity) {
        case 'light':
          amount = 30;
          break;
        case 'heavy':
          amount = 150;
          break;
        case 'jackpot':
          amount = 400; // HUGE EXPLOSION
          break;
        case 'medium':
        default:
          amount = 80;
          break;
      }`;
content = content.replace(amountTarget, amountReplace);
fs.writeFileSync(file, content, 'utf8');
