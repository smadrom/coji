import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

// HashRouter: routes live after `#` (e.g. /#/p/<id>) so deep-links, reload and
// back/forward work purely client-side — no nginx history fallback dependency.
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
