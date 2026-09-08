// Must stay the first import: the pinned Midnight bundles need `globalThis.Buffer`
// before any adapter chunk evaluates.
import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing application root');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
