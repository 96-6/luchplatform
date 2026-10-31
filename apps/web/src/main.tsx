import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
import { SecurityGate } from './auth/SecurityGate';
import { AuthProvider } from './auth/AuthContext';
import { BrowserGate, BrowserWarningBanner } from './auth/BrowserGate';
import { MeetingNavigationProvider } from './pages/meetings/MeetingNavigation';

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <ErrorBoundary>
        <SecurityGate>
          <BrowserGate>
            <AuthProvider>
              <MeetingNavigationProvider>
                <BrowserWarningBanner />
                <App />
              </MeetingNavigationProvider>
            </AuthProvider>
          </BrowserGate>
        </SecurityGate>
      </ErrorBoundary>
    ),
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
