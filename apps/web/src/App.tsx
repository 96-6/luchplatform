import { Route, Routes, Link, Navigate } from 'react-router-dom';
import { systemSchema } from '@luch/contracts';
import { Layout } from './components/Layout';
import { LoadingState, ErrorState } from './components/States';
import { HomePage } from './pages/HomePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { SystemPage } from './pages/SystemPage';
import { useResource } from './lib/useResource';
import { Protected } from './auth/AuthContext';
import {
  LoginPage,
  RegisterPage,
  VerifyEmailPage,
  AuthenticatorPage,
  DemoMailPage,
} from './pages/AuthPages';
import { StudentPage, TeacherPage, TeacherStudentPage } from './pages/AccountPages';
import { AdminPage } from './pages/AdminPage';
import { EngineHistoryPage, ExerciseRunPage } from './pages/EnginePages';
import {
  AdminContentPage,
  CourseCatalogPage,
  CourseRoutePage,
  LessonPreviewPage,
} from './pages/ContentPages';

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
            path="/learning"
            element={
              <Protected>
                <EngineHistoryPage />
              </Protected>
            }
          />
          <Route
            path="/learning/runs/:id"
            element={
              <Protected>
                <ExerciseRunPage />
              </Protected>
            }
          />
          <Route
            path="/admin/learning"
            element={
              <Protected role="superadmin">
                <EngineHistoryPage />
              </Protected>
            }
          />
          <Route
            path="/courses"
            element={
              <Protected>
                <CourseCatalogPage />
              </Protected>
            }
          />
          <Route
            path="/courses/:packageId/:routeId"
            element={
              <Protected>
                <CourseRoutePage />
              </Protected>
            }
          />
          <Route
            path="/courses/:packageId/:routeId/lessons/:lessonId"
            element={
              <Protected>
                <LessonPreviewPage />
              </Protected>
            }
          />
          <Route
            path="/admin/content"
            element={
              <Protected role="superadmin">
                <AdminContentPage />
              </Protected>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/authenticator" element={<AuthenticatorPage />} />
          <Route path="/demo-mail" element={<DemoMailPage />} />
          <Route
            path="/student"
            element={
              <Protected role="student">
                <StudentPage />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <Protected role="superadmin">
                <AdminPage />
              </Protected>
            }
          />
          <Route path="/network-check" element={<Navigate to="/" replace />} />
          <Route
            path="/plan"
            element={
              <Protected>
                <PlaceholderPage
                  title="Мой план"
                  description="Ваш индивидуальный план появится после анкеты и входной диагностики."
                />
              </Protected>
            }
          />
          <Route
            path="/assistant"
            element={
              <Protected>
                <PlaceholderPage
                  title="Помощник"
                  description="Здесь можно будет выбрать персонажа, получить объяснение и потренироваться в диалоге."
                />
              </Protected>
            }
          />
          <Route
            path="/schedule"
            element={
              <Protected>
                <PlaceholderPage
                  title="Расписание"
                  description="Здесь появятся назначенные занятия и ссылки на видеокомнаты."
                />
              </Protected>
            }
          />
          <Route
            path="/progress"
            element={
              <Protected>
                <PlaceholderPage
                  title="Прогресс"
                  description="Сохранённые ответы доступны в разделе «Обучение». Отчёт по навыкам, повторения и комментарии преподавателя появятся на следующих этапах."
                />
              </Protected>
            }
          />
          <Route
            path="/teacher"
            element={
              <Protected role="teacher">
                <TeacherPage />
              </Protected>
            }
          />
          <Route
            path="/teacher/students/:id"
            element={
              <Protected role="teacher">
                <TeacherStudentPage />
              </Protected>
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
