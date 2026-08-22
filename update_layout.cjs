const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

const searchStr = `
            <div className="lobby-club__info">
              <h2 className="lobby-club__name" title={club.name}>
                {club.name}
              </h2>
              <div className="lobby-club__meta">
                <span className="lobby-club__id">ID {club.club_id}</span>
                <span className="lobby-club__members">
                  <IconMembers />
                  {(club.member_count || 0).toLocaleString()}
                </span>
                {club.online_count > 0 && (
                  <span className="lobby-club__online">
                    {club.online_count.toLocaleString()} Online
                  </span>
                )}
              </div>

              {/* Club level.
                  Dan 2026-08-20: this page already loaded the level, already
                  called the recompute_club_levels RPC to correct a stale one,
                  and already fired a "Level Up!" toast when it rose — while
                  rendering the level itself NOWHERE. Players were congratulated
                  on reaching a level they could not see, and the stylesheet had
                  carried .club-level-badge / .club-level-progress rules with no
                  markup behind them. The work was being done; it just was not
                  reaching the screen. */}
              {clubLevel && (
                <div className="lobby-club__level">
                  <span
                    className="club-level-badge"
                    style={{ background: clubLevel.gradient }}
                    title={\`Level \${clubLevel.level} - \${clubLevel.tierLabel}\`}
                  >
                    <span className="club-level-badge__number">Lv.{clubLevel.level}</span>
                    <span className="club-level-badge__tier">{clubLevel.tierLabel}</span>
                  </span>
                </div>
              )}
            </div>

            <button
              className="lobby-club__share"
              aria-label="Share club invite link"
              title="Share"
              onClick={async () => {
                haptic.medium();
                const shareUrl = \`\${window.location.origin}/clubs/\${clubId}\`;
                try {
                  if (navigator.share) {
                    await navigator.share({
                      title: club.name,
                      text: \`Join \${club.name} on Smarter Poker!\`,
                      url: shareUrl,
                    });
                  } else {
                    await navigator.clipboard.writeText(shareUrl);
                    toast.success('Club link copied!');
                  }
                } catch (e) {
                  reportError(e, 'ClubHomePage.async');
                  /* user cancelled share */
                }
              }}
            >
              <IconShareLink />
            </button>
`;

const replaceStr = `
            <div className="lobby-club__info">
              <h2 className="lobby-club__name" title={club.name}>
                {club.name}
              </h2>
              <div className="lobby-club__meta">
                <span className="lobby-club__id">ID {club.club_id}</span>
                <span className="lobby-club__members">
                  <IconMembers />
                  {(club.member_count || 0).toLocaleString()}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                <div>
                  {clubLevel && (
                    <div className="lobby-club__level">
                      <span
                        className="club-level-badge"
                        style={{ background: clubLevel.gradient }}
                        title={\`Level \${clubLevel.level} - \${clubLevel.tierLabel}\`}
                      >
                        <span className="club-level-badge__number">Level {clubLevel.level}</span>
                        <span className="club-level-badge__tier">{clubLevel.tierLabel}</span>
                      </span>
                    </div>
                  )}
                  {club.online_count >= 0 && (
                    <div style={{ fontSize: '0.8rem', color: '#9aa5b6', marginTop: '4px' }}>
                      {club.online_count.toLocaleString()} players currently playing
                    </div>
                  )}
                </div>

                <button
                  className="lobby-club__share"
                  aria-label="Share club invite link"
                  title="Share"
                  onClick={async () => {
                    haptic.medium();
                    const shareUrl = \`\${window.location.origin}/clubs/\${clubId}\`;
                    try {
                      if (navigator.share) {
                        await navigator.share({
                          title: club.name,
                          text: \`Join \${club.name} on Smarter Poker!\`,
                          url: shareUrl,
                        });
                      } else {
                        await navigator.clipboard.writeText(shareUrl);
                        toast.success('Club link copied!');
                      }
                    } catch (e) {
                      reportError(e, 'ClubHomePage.async');
                      /* user cancelled share */
                    }
                  }}
                >
                  <IconShareLink />
                </button>
              </div>
            </div>
`;

if (code.includes(searchStr.trim().split('\\n')[0].trim())) { // weak check, but replace works
  // Just use simple replace or string matching
  const startIdx = code.indexOf('<div className="lobby-club__info">');
  const endIdx = code.indexOf('</button>', startIdx) + 9;
  
  if (startIdx !== -1 && endIdx !== -1) {
    code = code.substring(0, startIdx) + replaceStr.trim() + code.substring(endIdx);
    fs.writeFileSync(file, code);
    console.log("Replaced");
  } else {
    console.log("Could not find start/end bounds");
  }
} else {
  console.log("Could not find search str");
}
