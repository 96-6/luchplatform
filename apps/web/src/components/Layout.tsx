import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const navigation = [
  { to: '/', label: 'Главная', icon: '⌂' },
  { to: '/courses', label: 'Маршруты', icon: '▤' },
  { to: '/learning', label: 'Обучение', icon: '▶' },
  { to: '/onboarding', label: 'Анкета и диагностика', icon: '✓' },
  { to: '/plan', label: 'Мой план', icon: '≡' },
  { to: '/assistant', label: 'Помощник', icon: '◉' },
  { to: '/schedule', label: 'Расписание', icon: '▦' },
  { to: '/progress', label: 'Прогресс', icon: '↗' },
  { to: '/feedback', label: 'Комментарии преподавателя', icon: '✎' },
  { to: '/admin/providers', label: 'AI и расходы', icon: '⚙' },
  { to: '/operations', label: 'Обслуживание', icon: '⚒' },
  { to: '/teacher', label: 'Мои ученики', icon: '◇' },
];
export function Layout({ children, devTools }: { children: ReactNode; devTools: boolean }) {
  const [open, setOpen] = useState(false);
  const auth = useAuth();
  const navigate = useNavigate();
  const [logoutError, setLogoutError] = useState('');
  const user = auth.session.user;
  const visibleNavigation = user
    ? navigation
        .filter(
          (item) =>
            (item.to !== '/teacher' || user.role === 'teacher') &&
            (!['/learning', '/onboarding', '/plan', '/assistant', '/progress'].includes(item.to) ||
              user.role !== 'admin') &&
            (item.to !== '/feedback' || user.role === 'student') &&
            (item.to !== '/operations' || ['admin', 'superadmin'].includes(user.role)) &&
            (item.to !== '/admin/providers' || user.role === 'admin' || user.role === 'superadmin'),
        )
        .map((item) =>
          user.role === 'student' && item.to === '/'
            ? { ...item, to: '/student' }
            : item.to === '/plan' && user.role !== 'student'
              ? { ...item, label: 'Планы учеников' }
              : item.to === '/onboarding' && user.role !== 'student'
                ? { ...item, label: 'Анкеты и диагностика учеников' }
                : item.to === '/operations' && user.role === 'admin'
                  ? { ...item, label: 'Администратор' }
                  : item,
        )
    : [
        { to: '/', label: 'Главная', icon: '⌂' },
        { to: '/login', label: 'Войти', icon: '→' },
        { to: '/register', label: 'Регистрация', icon: '+' },
      ];
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        К содержимому
      </a>
      <aside className="sidebar">
        <div className="brand-row">
          <NavLink to="/" className="brand" aria-label="ЛУЧ — главная">
            <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
              <rect width="40" height="40" rx="12" fill="currentColor" />
              <path
                d="M12 28 20 11l8 17M16 23h8"
                fill="none"
                stroke="#fff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>
              ЛУЧ<small>Языки для жизни</small>
            </span>
          </NavLink>
          <button
            className="menu-toggle"
            aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen(!open)}
          >
            {open ? '✕' : '☰'}
          </button>
        </div>
        <nav
          id="main-nav"
          className={open ? 'navigation open' : 'navigation'}
          aria-label="Основная навигация"
        >
          {visibleNavigation.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
          {user && user.role === 'superadmin' && (
            <NavLink to={auth.session.dashboardPath ?? '/student'}>
              <span aria-hidden="true">◇</span>
              Суперадмин
            </NavLink>
          )}
          {devTools && (!user || user.role === 'superadmin') && (
            <NavLink to="/system">
              <span aria-hidden="true">⚙</span>Проверка системы
            </NavLink>
          )}
        </nav>
        <div className="sidebar-note">
          <strong>Русский · English</strong>
          <p>Учитесь в своём темпе.</p>
          <span className="badge">Начальная версия</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>Языковая платформа</span>
          <div className="topbar-account">
            {user ? (
              <>
                <span>{user.name}</span>
                <button
                  className="secondary"
                  onClick={() => {
                    setLogoutError('');
                    void auth
                      .logout()
                      .then(() => navigate('/login', { replace: true }))
                      .catch((error: Error) => setLogoutError(error.message));
                  }}
                >
                  Выйти
                </button>
              </>
            ) : (
              <span className="pill">РКИ и английский</span>
            )}
          </div>
        </header>
        <main id="content" tabIndex={-1}>
          {logoutError && (
            <p role="alert" className="error inline-message">
              {logoutError}
            </p>
          )}
          {children}
        </main>
        <footer>ЛУЧ · Персональное обучение</footer>
      </div>
    </div>
  );
}
