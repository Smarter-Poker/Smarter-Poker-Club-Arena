# The render harness

Renders a real Club Arena surface, with the real fonts and the real global CSS,
headless at 393px. It is the only honest way to judge a redesign and the only
way to produce the before/after Dan reviews.

Use a clean task-owned fixture checkout without credential files. Verify the three destination paths are absent before copying. Never overwrite or delete an existing environment file. Copy the three files into that checkout root, render, then delete only the files this task created. They are
deliberately not committed: `card-harness.tsx` imports pages directly and would
be dead weight in the bundle.

    cp .claude/skills/club-arena-console/harness/card-harness.html .
    cp .claude/skills/club-arena-console/harness/card-harness.tsx .
    cp .claude/skills/club-arena-console/harness/shot.mjs .shot.mjs
    export VITE_SUPABASE_URL=https://dummy.supabase.co
    export VITE_SUPABASE_ANON_KEY=dummy

    bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/before "?surface=rebuy"

    rm -f card-harness.html card-harness.tsx .shot.mjs

Add your surface to the `switch` in `card-harness.tsx`. `?click=Label` clicks a
button by its text 900ms after mount, which gets you the secondary states
(a composer open, a confirm step) without a second harness.

This legacy runner expects a Linux ARM64 browser environment. Inspect the actual host before using it; do not assume these paths or dependencies exist on macOS. Use private task-owned dependency/cache paths under the current owner policy. Its historical Linux provisioning commands are:

    export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw && npx playwright install chromium
    mkdir -p /tmp/debs /tmp/lib && cd /tmp/debs && apt-get download \
      libxdamage1 libxcomposite1 libxrandr2 libgbm1 libxkbcommon0 libpango-1.0-0 \
      libcairo2 libasound2 libatk1.0-0 libatk-bridge2.0-0 libnss3 libcups2 \
      libdrm2 libxfixes3 libatspi2.0-0 libxext6 libx11-xcb1 libxcb1 libnspr4 \
      libwayland-client0 libxshmfence1 && for d in *.deb; do dpkg-deb -x $d /tmp/lib; done

Fonts must be installed for the render to be truthful: Roboto Condensed and
Inter in `~/.fonts`. Without them every fitted label measures wrong.
