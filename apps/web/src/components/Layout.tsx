import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const navigation = [
  { to: '/', label: 'Главная', icon: '⌂' },
  { to: '/plan', label: 'Мой план', icon: '≡' },
  { to: '/assistant', label: 'Помощник', icon: '◉' },
  { to: '/schedule', label: 'Расписание', icon: '▦' },
  { to: '/progress', label: 'Прогресс', icon: '↗' },
  { to: '/teacher', label: 'Преподаватель', icon: '◇' },
];
export function Layout({ children, devTools }: { children: ReactNode; devTools: boolean }) {
  const [open, setOpen] = useState(false);
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
          {navigation.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
          {devTools && (
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
          <span className="pill">РКИ и английский</span>
        </header>
        <main id="content" tabIndex={-1}>
          {children}
        </main>
        <footer>ЛУЧ · Персональное обучение</footer>
      </div>
    </div>
  );
}
