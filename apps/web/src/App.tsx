import { Route, Routes, Link } from 'react-router-dom';
import { systemSchema } from '@luch/contracts';
import { Layout } from './components/Layout';
import { LoadingState, ErrorState } from './components/States';
import { HomePage } from './pages/HomePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { SystemPage } from './pages/SystemPage';
import { useResource } from './lib/useResource';

export function App() {
  const { state, refresh } = useResource('/system', systemSchema);
  const devTools = state.status === 'ready' && state.data.devToolsEnabled;
  return (
    <Layout devTools={devTools}>
      {state.status === 'loading' ? (
        <LoadingState text="Подключаемся к платформе…" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : (
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/plan"
            element={
              <PlaceholderPage
                title="Мой план"
                description="Ваш индивидуальный план появится после анкеты и входной диагностики."
              />
            }
          />
          <Route
            path="/assistant"
            element={
              <PlaceholderPage
                title="Помощник"
                description="Здесь можно будет выбрать персонажа, получить объяснение и потренироваться в диалоге."
              />
            }
          />
          <Route
            path="/schedule"
            element={
              <PlaceholderPage
                title="Расписание"
                description="Здесь появятся назначенные занятия и ссылки на видеокомнаты."
              />
            }
          />
          <Route
            path="/progress"
            element={
              <PlaceholderPage
                title="Прогресс"
                description="Ваши результаты, повторения и комментарии преподавателя появятся после начала обучения."
              />
            }
          />
          <Route
            path="/teacher"
            element={
              <PlaceholderPage
                title="Кабинет преподавателя"
                description="Список учеников, проверка ответов и назначения будут доступны после входа преподавателя."
              />
            }
          />
          <Route path="/system" element={<SystemPage enabled={devTools} />} />
          <Route
            path="*"
            element={
              <>
                <h1>Страница не найдена</h1>
                <Link to="/">Вернуться на главную</Link>
              </>
            }
          />
        </Routes>
      )}
    </Layout>
  );
}
