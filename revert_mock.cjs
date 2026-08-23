const fs = require('fs');
const file = 'src/services/MembershipService.ts';
let content = fs.readFileSync(file, 'utf8');

const regex = /let online = 0;\s*try \{\s*const \{ data: tables \} = await supabase.rpc\('get_active_tables_for_club'[\s\S]*?\} catch \(e\) \{\s*\/\* non-critical \*\/\s*\}/;

const replacement = `      // Estimate online count — creating a channel just to check presenceState()
      // on an unsubscribed channel always returned 0 and caused side-effect churn.
      // Real online tracking should come from a dedicated presence subscription.
      const online = Math.floor((active || 0) * 0.15);`;

content = content.replace(regex, replacement);
fs.writeFileSync(file, content);
