import { t } from '../i18n';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function HomePage() {
  const { session } = useAuth();
  if (session.user) return <Navigate to={session.dashboardPath ?? '/student'} replace />;
  return (
    <>
      <h1>{t('ЛУЧ')}</h1>
      <p className="lead">{t('Учебные маршруты РКИ и английского языка.')}</p>
      <div className="notice">
        <strong>{t('Вход и регистрация')}</strong>
        <p>
          {t(
            'Подтвердите почту и подключите Authenticator. В кабинете доступны демонстрационные маршруты РКИ и английского: мини-уроки, упражнения и сохранённые результаты.',
          )}
        </p>
        <Link className="text-link" to="/register">
          {t('Создать аккаунт →')}
        </Link>
      </div>
      <h2 className="section-title">{t('Два направления')}</h2>
      <div className="route-grid">
        <article className="route-card">
          <span className="language-mark">{t('Ру')}</span>
          <span className="muted">{t('Русский как иностранный')}</span>
          <h2>{t('Русский как иностранный')}</h2>
          <p>{t('Знакомство, повседневные ситуации и общение на русском.')}</p>
          <Link className="text-link" to="/courses">
            {t('Посмотреть маршруты ')}
            <span aria-hidden="true">→</span>
          </Link>
        </article>
        <article className="route-card">
          <span className="language-mark blue">En</span>
          <span className="muted">{t('Английский язык')}</span>
          <h2>{t('Английский язык')}</h2>
          <p>{t('Мини-уроки и упражнения английского языка.')}</p>
          <Link className="text-link" to="/courses">
            {t('Посмотреть маршруты ')}
            <span aria-hidden="true">→</span>
          </Link>
        </article>
      </div>
      <div className="next-grid">
        <Link to="/assistant">
          <strong>{t('Помощник')}</strong>
          <span>{t('Объяснения и языковая практика →')}</span>
        </Link>
        <Link to="/schedule">
          <strong>{t('Расписание')}</strong>
          <span>{t('Занятия с преподавателем →')}</span>
        </Link>
        <Link to="/progress">
          <strong>{t('Прогресс')}</strong>
          <span>{t('Ваши результаты и следующие шаги →')}</span>
        </Link>
      </div>
    </>
  );
}
