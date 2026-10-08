import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {initializePWAInstallCapture} from './services/pwaInstallService';

// Capture the browser's install event at application startup.
// The event may fire before the Settings page is ever mounted.
initializePWAInstallCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
