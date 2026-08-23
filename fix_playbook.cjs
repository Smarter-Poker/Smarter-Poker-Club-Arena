const fs = require('fs');
const glob = require('glob'); // we might not have glob, let's use child_process
const { execSync } = require('child_process');

const files = execSync('find /Users/smarter.poker/Documents -maxdepth 4 -name "AGENT-PLAYBOOK.md"').toString().trim().split('\n');
const ruleFiles = execSync('find /Users/smarter.poker/Documents -maxdepth 4 -name "00-agent-playbook.md"').toString().trim().split('\n');

const allFiles = [...new Set([...files, ...ruleFiles])].filter(f => f);

for (const file of allFiles) {
  let content = fs.readFileSync(file, 'utf8');
  
  // Need to replace the exact line. Let's use string replace.
  const oldLine = '| `.husky/pre-commit` → `scripts/guard-shared-clone.sh` | **Refuses a commit made in the shared clone.** Prints the exact command to get a proper tree. Never stashes, never checks anything out |';
  const newLine = '| `.husky/pre-commit` & `pre-push` → `scripts/guard-shared-clone.sh` | **Refuses a commit or push made in the shared clone.** Prints the exact command to get a proper tree. Never stashes, never checks anything out |';
  
  if (content.includes(oldLine)) {
    content = content.replace(oldLine, newLine);
    fs.writeFileSync(file, content);
    console.log(`Updated ${file}`);
  } else {
    // Maybe the formatting is slightly different?
    if (content.includes('scripts/guard-shared-clone.sh') && content.includes('Refuses a commit made in the shared clone')) {
      content = content.replace(/\|\s*`\.husky\/pre-commit`[^|]*\|\s*\*\*Refuses a commit made in the shared clone\.\*\*[^|]*\|/, newLine);
      fs.writeFileSync(file, content);
      console.log(`Updated ${file} (regex match)`);
    } else {
      console.log(`No match in ${file}`);
    }
  }
}
