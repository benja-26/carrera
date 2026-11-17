import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Navbar } from './components/Navbar';
import { LoginPage } from './pages/LoginPage';
import { AdminPage } from './pages/AdminPage';
import { TimekeeperPage } from './pages/TimekeeperPage';
import { ResultsPage } from './pages/ResultsPage';

const RequireAuth: React.FC<{
  children: React.ReactNode;
  role?: 'admin' | 'timekeeper';
}> = ({ children, role }) => {
  const { profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="p-8 text-center text-slate-400 text-sm font-semibold">
        Verificando sesión...
      </div>
    );
  }

  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  if (role === 'admin' && profile.role !== 'admin') {
    return <Navigate to="/crono" replace />;
  }

  return <>{children}</>;
};

const HomeRedirect: React.FC = () => {
  const { profile, loading } = useAuth();
  if (loading) return null;
  if (!profile) return <Navigate to="/login" replace />;
  return <Navigate to={profile.role === 'admin' ? '/admin' : '/crono'} replace />;
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="min-h-screen bg-slate-950 text-slate-50 flex flex-col">
          <Navbar />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<HomeRedirect />} />
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/admin"
                element={
                  <RequireAuth role="admin">
                    <AdminPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/crono"
                element={
                  <RequireAuth>
                    <TimekeeperPage />
                  </RequireAuth>
                }
              />
              <Route path="/resultados" element={<ResultsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
};

export default App;
