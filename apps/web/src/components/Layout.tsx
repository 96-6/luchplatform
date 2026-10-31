import { t } from '../i18n';
import { LanguageSelector } from '../i18n/LanguageSelector';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useMeetingNavigation } from '../pages/meetings/MeetingNavigation';

const navigation = [
  { to: '/', label: t('Главная'), icon: '⌂' },
  { to: '/courses', label: t('Маршруты'), icon: '▤' },
  { to: '/learning', label: t('Обучение'), icon: '▶' },
  { to: '/onboarding', label: t('Анкета и диагностика'), icon: '✓' },
  { to: '/plan', label: t('Мой план'), icon: '≡' },
  { to: '/assistant', label: t('Помощник'), icon: '◉' },
  { to: '/schedule', label: t('Расписание'), icon: '▦' },
  { to: '/progress', label: t('Прогресс'), icon: '↗' },
  { to: '/feedback', label: t('Комментарии преподавателя'), icon: '✎' },
  { to: '/admin/providers', label: t('AI и расходы'), icon: '⚙' },
  { to: '/operations', label: t('Обслуживание'), icon: '⚒' },
  { to: '/teacher', label: t('Мои ученики'), icon: '◇' },
  { to: '/account/security', label: t('Безопасность аккаунта'), icon: '⚿' },
];
export function Layout({ children, devTools }: { children: ReactNode; devTools: boolean }) {
  const [open, setOpen] = useState(false);
  const auth = useAuth();
  const meetingNavigation = useMeetingNavigation();
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
              ? { ...item, label: t('Планы учеников') }
              : item.to === '/onboarding' && user.role !== 'student'
                ? { ...item, label: t('Анкеты и диагностика учеников') }
                : item.to === '/operations' && user.role === 'admin'
                  ? { ...item, label: t('Администратор') }
                  : item,
        )
    : [
        { to: '/', label: t('Главная'), icon: '⌂' },
        { to: '/login', label: t('Войти'), icon: '→' },
        { to: '/register', label: t('Регистрация'), icon: '+' },
      ];
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  return (
    <div
      className={`app-shell${/^\/(?:guest\/)?meetings\/[^/]+\/room$/.test(location.pathname) ? ' meeting-workspace' : ''}`}
    >
      <a className="skip-link" href="#content">
        {t('К содержимому')}
      </a>
      <aside className="sidebar">
        <div className="brand-row">
          <NavLink to="/" className="brand" aria-label={t('ЛУЧ — главная')}>
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
            <span>{t('ЛУЧ')}</span>
          </NavLink>
          <button
            className="menu-toggle"
            aria-label={open ? t('Закрыть меню') : t('Открыть меню')}
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
          aria-label={t('Основная навигация')}
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
              {t('Суперадмин')}
            </NavLink>
          )}
          {devTools && (!user || user.role === 'superadmin') && (
            <NavLink to="/system">
              <span aria-hidden="true">⚙</span>
              {t('Проверка системы')}
            </NavLink>
          )}
        </nav>
        <div className={open ? 'sidebar-note menu-open' : 'sidebar-note'}>
          <LanguageSelector />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>{t('ЛУЧ')}</span>
          <div className="topbar-account">
            {user ? (
              <>
                <span>{user.name}</span>
                <button
                  className="secondary"
                  onClick={() => {
                    setLogoutError('');
                    meetingNavigation.request({
                      href: '/login',
                      action: () =>
                        auth
                          .logout()
                          .then(() => navigate('/login', { replace: true }))
                          .catch((error: Error) => setLogoutError(t(error.message))),
                    });
                  }}
                >
                  {t('Выйти')}
                </button>
              </>
            ) : (
              <span className="pill">{t('РКИ и английский')}</span>
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
        <footer>{t('ЛУЧ')}</footer>
      </div>
    </div>
  );
}
