const fs = require('fs');
let content = fs.readFileSync('vite.config.ts', 'utf8');

content = content.replace(
  /__SENTRY_DEBUG__: false,/g,
  `__SENTRY_DEBUG__: false,
    __SENTRY_TRACING__: false,
    __RRWEB_EXCLUDE_IFRAME__: true,
    __RRWEB_EXCLUDE_SHADOW_DOM__: true,
    __SENTRY_EXCLUDE_REPLAY_WORKER__: true,`
);
fs.writeFileSync('vite.config.ts', content);
