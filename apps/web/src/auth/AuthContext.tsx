import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { sessionSchema, messageSchema, type Session, type User } from '@luch/contracts';
import { api, setCsrfToken } from '../lib/api';
import { LoadingState, ErrorState } from '../components/States';

const empty: Session = { user: null, csrfToken: null, dashboardPath: null };
const AuthContext = createContext<{
  session: Session;
  loading: boolean;
  error: Error | null;
  accept: (session: Session) => void;
  refresh: () => void;
  logout: () => Promise<void>;
} | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth context unavailable');
  return value;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const accept = (value: Session) => {
    setSession(value);
    setCsrfToken(value.csrfToken);
    setLoading(false);
    setError(null);
  };
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api('/auth/session', sessionSchema, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) accept(value);
      },
      (failure: Error) => {
        if (!controller.signal.aborted) {
          setError(failure);
          setLoading(false);
        }
      },
    );
    return () => {
      controller.abort();
      setCsrfToken(null);
    };
  }, [revision]);
  const logout = async () => {
    await api('/auth/logout', messageSchema, { body: {} });
    accept(empty);
  };
  return (
    <AuthContext.Provider value={{ session, loading, error, accept, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
export function Protected({
  children,
  role,
  roles,
}: {
  children: ReactNode;
  role?: User['role'];
  roles?: User['role'][];
}) {
  const auth = useAuth();
  if (auth.loading) return <LoadingState />;
  if (auth.error) return <ErrorState error={auth.error} retry={auth.refresh} />;
  if (!auth.session.user) return <Navigate to="/login" replace />;
  if (
    (role && auth.session.user.role !== role) ||
    (roles && !roles.includes(auth.session.user.role))
  )
    return <Navigate to={auth.session.dashboardPath ?? '/login'} replace />;
  return children;
}
