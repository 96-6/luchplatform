import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
import { SecurityGate } from './auth/SecurityGate';
import { AuthProvider } from './auth/AuthContext';
import { BrowserGate, BrowserWarningBanner } from './auth/BrowserGate';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <SecurityGate>
          <BrowserGate>
            <AuthProvider>
              <BrowserWarningBanner />
              <App />
            </AuthProvider>
          </BrowserGate>
        </SecurityGate>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
