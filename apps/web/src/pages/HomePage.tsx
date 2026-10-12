import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function HomePage() {
  const { session } = useAuth();
  return (
    <>
      <p className="eyebrow">Начните с вашей цели</p>
      <h1>
        Больше уверенности.
        <br />
        Больше возможностей.
      </h1>
      <p className="lead">
        Русский и английский для учёбы, работы и повседневной жизни. Ваш план, практика и поддержка
        преподавателя — в одном месте.
      </p>
      <div className="notice">
        <strong>
          {session.user
            ? `С возвращением, ${session.user.name}.`
            : 'Ваш аккаунт — первый шаг к обучению.'}
        </strong>
        <p>
          Подтвердите почту и подключите Authenticator. В кабинете доступны демонстрационные
          маршруты РКИ и английского с материалами мини-уроков.
        </p>
        <Link className="text-link" to={session.dashboardPath ?? '/register'}>
          {session.user ? 'Открыть кабинет →' : 'Создать аккаунт →'}
        </Link>
      </div>
      <h2 className="section-title">Два направления</h2>
      <div className="route-grid">
        <article className="route-card">
          <span className="language-mark">Ру</span>
          <span className="muted">Русский как иностранный</span>
          <h2>
            Для учёбы и жизни
            <br />в новой среде
          </h2>
          <p>Знакомство, повседневные ситуации и общение на русском.</p>
          <Link className="text-link" to="/courses">
            Посмотреть маршруты <span aria-hidden="true">→</span>
          </Link>
        </article>
        <article className="route-card">
          <span className="language-mark blue">En</span>
          <span className="muted">Английский язык</span>
          <h2>
            Для общения
            <br />
            без лишних барьеров
          </h2>
          <p>Понятные шаги к языку для работы, поездок и жизни.</p>
          <Link className="text-link" to="/courses">
            Посмотреть маршруты <span aria-hidden="true">→</span>
          </Link>
        </article>
      </div>
      <div className="next-grid">
        <Link to="/assistant">
          <strong>Помощник</strong>
          <span>Объяснения и языковая практика →</span>
        </Link>
        <Link to="/schedule">
          <strong>Расписание</strong>
          <span>Занятия с преподавателем →</span>
        </Link>
        <Link to="/progress">
          <strong>Прогресс</strong>
          <span>Ваши результаты и следующие шаги →</span>
        </Link>
      </div>
    </>
  );
}
