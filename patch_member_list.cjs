const fs = require('fs');
const file = 'src/components/club/MemberList.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /<button\n\s*className="member-action-btn member-action-btn--danger"\n\s*title="Kick"\n\s*aria-label="Kick"\n\s*onClick=\{\(\) => onKick\(member\.id\)\}\n\s*><\/button>/,
  `<button
                        className="member-action-btn member-action-btn--danger"
                        title="Kick"
                        aria-label="Kick"
                        onClick={() => onKick(member.id)}
                      ></button>
                      <button
                        className="member-action-btn member-action-btn--danger"
                        title="Ban"
                        aria-label="Ban"
                        onClick={() => onBan(member.id)}
                      ></button>`
);

fs.writeFileSync(file, content);
