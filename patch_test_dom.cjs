const fs = require('fs');
const file = 'tests/e2e/live-animations.spec.ts';
let content = fs.readFileSync(file, 'utf8');

// Add the missing DOM elements for the spin test
content = content.replace(
  /const s=document\.createElement\('div'\);s\.className='sw__segment sw__segment--win';\n\s*s\.innerHTML='<div class="sw__wedge"><\/div>';st\.appendChild\(s\);/,
  `const s=document.createElement('div');s.className='sw__segment sw__segment--win';
       s.innerHTML='<svg><path class="sw__edge--halo"></path></svg><div class="sw__wedge"></div>';st.appendChild(s);`
);

fs.writeFileSync(file, content);
