const fs = require('fs');
let code = fs.readFileSync('src/components/wallet/ClubBankCashierModal.tsx', 'utf8');

// 1. Remove the sub-title (description)
code = code.replace(
  /<div className="cbc-sub">[\s\S]*?<\/div>/,
  ''
);
// Make sure title is CLUB BANK
code = code.replace(
  /<div className="cbc-title">CLUB BANK CASHIER<\/div>/,
  '<div className="cbc-title">CLUB BANK</div>'
);

// Remove cbc-note for union
code = code.replace(
  /\{\s*inUnion === true && \(\s*<div className="cbc-note">\s*This Club Is In A Union, So Chip Minting Is Revoked\. Chips Flow Down From The Union\s*Bank\.\s*<\/div>\s*\)\}/g,
  ''
);

// 2. Remove cbc-quick buttons
code = code.replace(
  /<div className="cbc-quick">[\s\S]*?<\/div>/,
  ''
);

// 3. Placeholders and strings
code = code.replace(/placeholder="Chips to send"/g, 'placeholder=""');
code = code.replace(/placeholder=\{\s*AGENT_ONLY\.includes\(destination\) \? 'Search agents' : 'Search members'\s*\}/g, "placeholder={AGENT_ONLY.includes(destination) ? 'Search Agents' : 'Search Members'}");
code = code.replace(/aria-label="Chips to send"/g, 'aria-label=""');
code = code.replace(/'No Agents In This Club Yet\. Promote A Member To Agent First\.'/g, "'No Agents In This Club Yet. Promote A Member To Agent First.'");
code = code.replace(/'No Members Match That Search\.'/g, "'No Members Match That Search.'");

// 4. Avatars and IDs for members
// Add avatar_url and short_id to the query
code = code.replace(
  /\.select\('user_id, role, display_name, nickname, chip_balance'\)/g,
  ".select('user_id, role, display_name, nickname, avatar_url, short_id, chip_balance')"
);

// Update setMembers
code = code.replace(
  /chip_balance: Number\(m\.chip_balance\) \|\| 0,/g,
  "chip_balance: Number(m.chip_balance) || 0,\n          avatar_url: (m.avatar_url as string) || '',\n          short_id: (m.short_id as string) || '----',"
);

// Add to Member interface
code = code.replace(
  /name: string;/g,
  "name: string;\n  avatar_url?: string;\n  short_id?: string;"
);

// Render them in the list
const newMemberRender = `
                        <div className="cbc-member-avatar" style={{ backgroundImage: \`url(\${m.avatar_url || ''})\` }} />
                        <div className="cbc-member-info">
                          <span className="cbc-member-name">{m.name}</span>
                          <span className="cbc-member-id">#{m.short_id}</span>
                        </div>
                        <span className="cbc-member-role">{roleLabel(m.role)}</span>
                        <span className="cbc-member-bal">{fmt(m.chip_balance)}</span>
`;
code = code.replace(
  /<span className="cbc-member-name">\{m\.name\}<\/span>\s*<span className="cbc-member-role">\{roleLabel\(m\.role\)\}<\/span>\s*<span className="cbc-member-bal">\{fmt\(m\.chip_balance\)\}<\/span>/g,
  newMemberRender
);

fs.writeFileSync('src/components/wallet/ClubBankCashierModal.tsx', code);
