const fs = require('fs');
const { execSync } = require('child_process');

const rule1 = execSync('find /Users/smarter.poker/Documents -maxdepth 4 -name "00-agent-playbook.md"').toString().trim().split('\n').filter(f => f);
const rule2 = execSync('find /Users/smarter.poker/Documents -maxdepth 4 -name "00-anti-regression-workflow.md"').toString().trim().split('\n').filter(f => f);

for (const file of rule1) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('\`pre-commit\` refuses commits in that')) {
    content = content.replace('\`pre-commit\` refuses commits in that', '\`pre-commit\` and \`pre-push\` refuse commits and pushes in that');
    fs.writeFileSync(file, content);
    console.log(`Updated ${file}`);
  }
}

for (const file of rule2) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('This is enforced now, not advised. `.husky/pre-commit` runs')) {
    content = content.replace('This is enforced now, not advised. `.husky/pre-commit` runs', 'This is enforced now, not advised. `.husky/pre-commit` and `.husky/pre-push` run');
    content = content.replace('refuses a commit whose', 'refuse a commit or push whose');
    fs.writeFileSync(file, content);
    console.log(`Updated ${file}`);
  }
}
