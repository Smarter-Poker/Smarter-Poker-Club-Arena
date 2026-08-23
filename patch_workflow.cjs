const fs = require('fs');
const file = '.github/workflows/schema-manifest-refresh.yml';
let content = fs.readFileSync(file, 'utf8');

// Change the branch generation to be static
content = content.replace(
  /BRANCH="chore\/schema-manifest-\$\(git rev-parse --short HEAD\)"/,
  'BRANCH="chore/schema-manifest-refresh"'
);

// Change checkout to -B so it overrides or creates
content = content.replace(
  /git checkout -b "\$BRANCH"/,
  'git checkout -B "$BRANCH"'
);

// Replace the bailout with force-push and PR creation only if needed
content = content.replace(
  /git push origin "\$BRANCH"\n\n\s*# If a PR is already open[\s\S]*?exit 0\n\s*fi\n\n\s*# GitHub Actions cannot open PRs unless/m,
  `git push -f origin "$BRANCH"

          # Only open a PR if one isn't already open for this branch
          OPEN=$(gh pr list --state open --head "$BRANCH" --json number --jq 'length')
          if [ "$OPEN" != "0" ]; then
            echo "::notice::Manifest updated in existing PR for branch $BRANCH."
            exit 0
          fi

          # GitHub Actions cannot open PRs unless`
);

fs.writeFileSync(file, content);
