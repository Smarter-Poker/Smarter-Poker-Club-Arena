/** Standalone entry: deliberately excludes App, authentication and financial services. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import DiamondTestPage from './pages/DiamondTestPage';
import './styles/club-engine.css';
import './styles/animations.css';
import './styles/metallic-popups.css';
import './styles/reducedMotion.css';
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <DiamondTestPage />
  </BrowserRouter>
);
