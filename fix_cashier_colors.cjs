const fs = require('fs');

const files = [
  'src/pages/CashierTradePage.module.css',
  'src/pages/CashierPage.module.css',
  'src/components/club/CashierModal.css',
  'src/pages/CashierPage.tsx',
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf8');

  // Replace gradients
  content = content.replace(/background:\s*linear-gradient\(180deg,\s*#f8d264\s+0%,\s*#eab308\s+100%\)/g, 
    'background: linear-gradient(180deg, rgba(24, 119, 242, 0.2) 0%, rgba(10, 93, 194, 0.1) 100%)');

  // Specific overrides for buttons to make them pop more than just tabs
  content = content.replace(/\.footerBtn\s*\{\s*flex:\s*1;[\s\S]*?\}/g, match => {
    return match.replace(/background:.*?;/, 'background: linear-gradient(180deg, #1877f2 0%, #0a5dc2 100%);\n  box-shadow: 0 4px 12px rgba(24,119,242,0.4), inset 0 1px 0 rgba(255,255,255,0.2);\n  border: 1px solid #6fdcff;\n  text-shadow: 0 1px 2px rgba(0,0,0,0.5);')
                .replace(/color:\s*#1a1a1a;/, 'color: #fff;');
  });
  
  content = content.replace(/\.reqBtnGo\s*\{[\s\S]*?\}/g, match => {
    return match.replace(/background:.*?;/, 'background: linear-gradient(180deg, #1877f2 0%, #0a5dc2 100%);\n  box-shadow: 0 4px 12px rgba(24,119,242,0.4), inset 0 1px 0 rgba(255,255,255,0.2);')
                .replace(/color:\s*#1a1a1a;/, 'color: #fff;\n  border: 1px solid #6fdcff;');
  });

  content = content.replace(/\.modalConfirm\s*\{[\s\S]*?\}/g, match => {
    return match.replace(/background:.*?;/, 'background: linear-gradient(180deg, #1877f2 0%, #0a5dc2 100%) !important;\n  box-shadow: 0 4px 12px rgba(24,119,242,0.4), inset 0 1px 0 rgba(255,255,255,0.2) !important;\n  border: 1px solid #6fdcff !important;')
                .replace(/color:\s*#1a1a1a\s*!important;/, 'color: #fff !important;\n  text-shadow: 0 1px 2px rgba(0,0,0,0.5) !important;');
  });

  // Replace tabActive gradient
  content = content.replace(/\.tabActive\s*\{[\s\S]*?\}/g, match => {
    return match.replace(/background:.*?;/, 'background: linear-gradient(180deg, rgba(24, 119, 242, 0.2) 0%, rgba(10, 93, 194, 0.1) 100%);\n  border: 1px solid #1877f2;\n  box-shadow: 0 0 12px rgba(24, 119, 242, 0.3), inset 0 1px 0 rgba(255,255,255,0.1);')
                .replace(/color:\s*#1a1a1a;/, 'color: #6fdcff;');
  });

  // Replace text colors
  content = content.replace(/#ffb800/g, '#6fdcff');
  content = content.replace(/#FFD700/g, '#6fdcff');

  // Fix inline styles in tsx
  if (file.endsWith('.tsx')) {
    content = content.replace(/background:\s*'#ffb800'/g, "background: '#6fdcff'");
  }

  // Row selected background
  content = content.replace(/rgba\(255,\s*184,\s*0,\s*0\.07\)/g, 'rgba(111, 220, 255, 0.1)');

  fs.writeFileSync(file, content, 'utf8');
}

console.log("Done");
