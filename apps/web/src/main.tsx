import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { BackendProvider } from './lib/backend-context.js';
import { ToastProvider } from './lib/toast.js';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from the document');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <BackendProvider>
        <App />
      </BackendProvider>
    </ToastProvider>
  </StrictMode>,
);
