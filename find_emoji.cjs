const fs = require('fs');
const glob = require('glob');

const files = glob.sync('src/**/*.{tsx,ts,css}');
const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F200}-\u{1F251}]/u;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (emojiRegex.test(content)) {
    console.log(file);
  }
}
