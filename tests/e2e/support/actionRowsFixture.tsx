import React from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../../../src/components/common/Toast';
import { Review } from './portraitRailScene';
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <Review />
  </ToastProvider>
);
