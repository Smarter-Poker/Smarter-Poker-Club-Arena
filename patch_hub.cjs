const fs = require('fs');
const file = '../Smarter-Poker-World-Hub/src/components/training/HandReplayViewer.jsx';
if (fs.existsSync(file)) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(
    /const suitMap = \{ h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' \};/g,
    `const suitMap = { h: '♥', d: '♦', c: '♣', s: '♠' };`
  );
  fs.writeFileSync(file, content);
}
