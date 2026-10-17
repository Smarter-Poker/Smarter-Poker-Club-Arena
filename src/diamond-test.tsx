/** Standalone entry: deliberately excludes App, authentication and financial services. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ROUTER_BASENAME } from './lib/appBase';
import DiamondTestPage from './pages/DiamondTestPage';
import './styles/club-engine.css';
import './styles/animations.css';
import './styles/metallic-popups.css';
import './styles/reducedMotion.css';
import './styles/single-field-focus.css';
import { installSingleFieldFocus } from './lib/singleFieldFocus.mjs';
const disposeSingleFieldFocus = installSingleFieldFocus(document);
if (import.meta.hot) import.meta.hot.dispose(disposeSingleFieldFocus);
createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={ROUTER_BASENAME}>
    <DiamondTestPage />
  </BrowserRouter>
);
