import '../../../src/styles/club-engine.css';
import '../../../src/styles/animations.css';
import '../../../src/styles/metallic-popups.css';
import '../../../src/styles/reducedMotion.css';
import '../../../src/pages/ClubHomePage.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ClubBBJShell } from '../../../src/components/wallet/ClubWalletArtwork';
import { DiamondJackpotReadout } from '../../../src/components/bbj/DiamondJackpotReadout';

document.body.style.cssText = 'margin:0;background:#000;font-family:Arial';
const layout = document.createElement('style');
layout.textContent =
  '.lobby-bbj{width:calc((100vw - 34px)/2);max-width:400px;aspect-ratio:1566/672;margin:20px}';
document.head.appendChild(layout);
const amount = Number(new URLSearchParams(location.search).get('amount') || 0);
createRoot(document.getElementById('root')!).render(
  <button
    className="lobby-bbj"
    aria-label={`Bad Beat Jackpot: ${amount.toLocaleString('en-US')} Diamonds`}
    onClick={() => (document.body.dataset.clicked = 'true')}
  >
    <ClubBBJShell className="lobby-bbj__shell" />
    <DiamondJackpotReadout amount={amount} />
  </button>
);
