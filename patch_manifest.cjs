const fs = require('fs');
const file = 'scripts/ci/supabase-schema-manifest.json';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /<<<<<<< HEAD\n\s*"fn_reroll_challenge",\n\s*"ca_club_grantable_roles",\n\s*"fn_club_set_member_role"\n=======\n\s*"fn_reroll_challenge"\n>>>>>>> origin\/main/,
  `"fn_reroll_challenge",\n    "ca_club_grantable_roles",\n    "fn_club_set_member_role"`
);

fs.writeFileSync(file, content);
