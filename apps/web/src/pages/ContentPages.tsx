import { t } from '../i18n';
import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  CONTENT_MAX_BYTES,
  catalogSchema,
  contentPackageSchema,
  contentPackagesSchema,
  importResultSchema,
  lessonViewSchema,
  routeViewSchema,
  type ContentAsset,
  type ContentBlock,
  type ContentPackage,
  type ExercisePurpose,
} from '@luch/contracts';
import { useResource } from '../lib/useResource';
import { api } from '../lib/api';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StartLessonButton } from './EnginePages';

const purposeLabels: Record<ExercisePurpose, string> = {
  practice: t('Тренировка'),
  diagnostic: t('Диагностика'),
  control: t('Контроль'),
};
export function CourseCatalogPage() {
  const { state, refresh } = useResource('/content/routes', catalogSchema);
  return (
    <>
      <p className="eyebrow">{t('Учебные материалы')}</p>
      <h1>{t('Языковые маршруты')}</h1>
      {state.status === 'loading' ? (
        <LoadingState />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={refresh} />
      ) : state.data.length ? (
        <div className="course-grid">
          {state.data.map((route) => (
            <section className="panel" key={`${route.packageId}:${route.id}`}>
              <span className="badge">
                {route.language === 'ru' ? t('РКИ') : 'English'} · {route.level}
                {route.isDemo ? t(' · Демо') : ''}
              </span>
              <h2>{route.title}</h2>
              <p>{route.description}</p>
              <p>
                {route.lessonCount} {t(' коротких уроков')}
              </p>
              <Link
                to={`/courses/${route.packageId}/${route.id}?packageVersion=${route.packageVersion}`}
              >
                {t('Открыть маршрут →')}
              </Link>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          title={t('Материалы пока не загружены')}
          description={t('Администратор может импортировать пакет учебных материалов.')}
        />
      )}
    </>
  );
}
export function CourseRoutePage() {
  const { packageId, routeId } = useParams();
  const [params] = useSearchParams();
  const revision = params.get('packageVersion');
  const { state, refresh } = useResource(
    `/content/packages/${packageId}/routes/${routeId}${revision ? `?packageVersion=${encodeURIComponent(revision)}` : ''}`,
    routeViewSchema,
  );
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const route = state.data;
  return (
    <>
      <Link to="/courses">{t('← Все маршруты')}</Link>
      <h1>{route.title}</h1>
      <p>{route.description}</p>
      <span className="badge">
        {route.level}
        {route.isDemo ? t(' · Демонстрационный контент') : ''}
      </span>
      <section className="panel">
        <h2>{t('Цели маршрута')}</h2>
        <ul>
          {route.goals.map((goal) => (
            <li key={goal}>{goal}</li>
          ))}
        </ul>
      </section>
      <ol className="lesson-list">
        {route.lessons.map((lesson, index) => (
          <li className="panel" key={lesson.id}>
            <h2>
              {index + 1}. {lesson.title}
            </h2>
            <p>{lesson.summary}</p>
            <p>
              {lesson.estimatedMinutes} {t(' минут')}
            </p>
            <Link
              to={`/courses/${route.packageId}/${route.id}/lessons/${lesson.id}?packageVersion=${route.packageVersion}`}
            >
              {t('Посмотреть урок →')}
            </Link>
          </li>
        ))}
      </ol>
      <section className="panel">
        <h2>{t('Наборы заданий')}</h2>
        <ul>
          {route.sets.map((set) => (
            <li key={set.id}>
              {set.title}: {set.exerciseIds.length} {t(' заданий')}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
export function ContentBlocks({
  blocks,
  assets,
}: {
  blocks: ContentBlock[];
  assets: ContentAsset[];
}) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const failed = (src: string) =>
    setFailedSources((sources) => (sources.includes(src) ? sources : [...sources, src]));
  return (
    <div className="lesson-blocks">
      {blocks.map((block) => {
        if (block.type === 'text')
          return (
            <section key={block.id}>
              {block.heading && <h3>{block.heading}</h3>}
              <p className="content-text">{block.text}</p>
            </section>
          );
        if (block.type === 'vocabulary')
          return (
            <section key={block.id}>
              {block.heading && <h3>{block.heading}</h3>}
              <dl className="vocabulary-list">
                {block.items.map((item, i) => (
                  <div key={i}>
                    <dt>{item.term}</dt>
                    <dd>
                      {item.translation}
                      {item.example && <p>{item.example}</p>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        if (block.type === 'dialogue')
          return (
            <section key={block.id}>
              {block.heading && <h3>{block.heading}</h3>}
              <ul className="dialogue-list">
                {block.lines.map((line, i) => (
                  <li key={i}>
                    <strong>{line.speaker}:</strong> {line.text}
                  </li>
                ))}
              </ul>
            </section>
          );
        const asset = byId.get(block.assetId);
        if (!asset)
          return (
            <p key={block.id} role="alert">
              {t('Материал пока недоступен.')}
            </p>
          );
        if (block.type === 'image')
          return (
            <figure key={block.id}>
              {failedSources.includes(asset.src) ? (
                <p role="alert">
                  {t('Изображение недоступно: ')}
                  {block.alt}
                </p>
              ) : (
                <img
                  className="lesson-image"
                  src={asset.src}
                  alt={block.alt}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => failed(asset.src)}
                />
              )}
              {block.caption && <figcaption>{block.caption}</figcaption>}
            </figure>
          );
        if (block.type === 'file')
          return (
            <section key={block.id}>
              <a href={asset.src} target="_blank" rel="noopener noreferrer" download>
                {block.label}
              </a>
              {block.description && <p>{block.description}</p>}
            </section>
          );
        return (
          <section key={block.id}>
            {block.caption && <h3>{block.caption}</h3>}
            {block.type === 'audio' ? (
              <audio controls preload="none" src={asset.src} onError={() => failed(asset.src)}>
                {t('Аудио: ')}
                <a href={asset.src}>{t('Открыть запись')}</a>
              </audio>
            ) : (
              <video controls preload="none" src={asset.src} onError={() => failed(asset.src)}>
                {t('Видео: ')}
                <a href={asset.src}>{t('Открыть запись')}</a>
              </video>
            )}
            {failedSources.includes(asset.src) && (
              <p role="alert">{t('Не удалось загрузить запись. Используйте текст записи ниже.')}</p>
            )}
            <details>
              <summary>{t('Текст записи')}</summary>
              <p className="content-text">{block.transcript}</p>
            </details>
          </section>
        );
      })}
    </div>
  );
}
export function LessonPreviewPage() {
  const { packageId, routeId, lessonId } = useParams();
  const [params, setParams] = useSearchParams();
  const purpose = (params.get('purpose') ?? 'practice') as ExercisePurpose;
  const revision = params.get('packageVersion');
  const { state, refresh } = useResource(
    `/content/packages/${packageId}/lessons/${lessonId}?purpose=${encodeURIComponent(purpose)}${revision ? `&packageVersion=${encodeURIComponent(revision)}` : ''}`,
    lessonViewSchema,
  );
  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState error={state.error} retry={refresh} />;
  const lesson = state.data;
  if (lesson.routeId !== routeId)
    return (
      <EmptyState
        title={t('Урок не найден в этом маршруте')}
        description={t('Вернитесь к списку языковых маршрутов.')}
      />
    );
  return (
    <>
      <Link
        to={`/courses/${lesson.packageId}/${lesson.routeId}?packageVersion=${lesson.packageVersion}`}
      >
        {t('← К маршруту')}
      </Link>
      <h1>{lesson.title}</h1>
      <p>{lesson.summary}</p>
      <span className="badge">
        {lesson.estimatedMinutes} {t(' минут')}
        {lesson.isDemo ? t(' · Демо') : ''}
      </span>
      <section className="panel">
        <ContentBlocks blocks={lesson.blocks} assets={lesson.assets} />
      </section>
      <section className="panel">
        <h2>{t('Проверяемые навыки')}</h2>
        <ul>
          {lesson.skills.map((skill) => (
            <li key={skill.id}>
              {skill.title}: {skill.description}
            </li>
          ))}
        </ul>
      </section>
      <h2>{t('Задания урока')}</h2>
      <p>
        {t('Начните прохождение: движок сохранит ответы и поможет продолжить урок после перерыва.')}
      </p>
      <div className="tabs" role="tablist" aria-label={t('Набор заданий')}>
        {(['practice', 'diagnostic', 'control'] as const).map((mode) => (
          <button
            key={mode}
            role="tab"
            aria-selected={mode === purpose}
            className={mode === purpose ? '' : 'secondary'}
            onClick={() =>
              setParams({ packageVersion: String(lesson.packageVersion), purpose: mode })
            }
          >
            {purposeLabels[mode]}
          </button>
        ))}
      </div>
      {lesson.exercises.length > 0 && (
        <StartLessonButton
          packageId={lesson.packageId}
          packageVersion={lesson.packageVersion}
          lessonId={lesson.id}
          purpose={purpose}
        />
      )}
      {lesson.exercises.length ? (
        lesson.exercises.map((exercise, index) => (
          <section className="panel exercise-preview" key={exercise.id}>
            <h3>
              {t('Задание ')}
              {index + 1}
            </h3>
            <p>{exercise.instruction}</p>
            <ContentBlocks blocks={exercise.blocks} assets={lesson.assets} />
            {exercise.response.type === 'choice' ? (
              <ul>
                {exercise.response.options.map((option) => (
                  <li key={option.id}>{option.text}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {t('Короткий текстовый ответ, до ')}
                {exercise.response.maxLength} {t(' символов.')}
              </p>
            )}
          </section>
        ))
      ) : (
        <EmptyState
          title={t('В этом наборе пока нет заданий')}
          description={t('Выберите другой набор или вернитесь к маршруту.')}
        />
      )}
    </>
  );
}
export function AdminContentPage() {
  const { state, refresh } = useResource('/admin/content/packages', contentPackagesSchema, true);
  const [draft, setDraft] = useState<ContentPackage | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  async function select(file?: File) {
    setDraft(null);
    setError('');
    setMessage('');
    if (!file) return;
    setReading(true);
    try {
      if (file.size > CONTENT_MAX_BYTES)
        throw new Error(t('Размер пакета должен быть не более 2 МиБ.'));
      const result = contentPackageSchema.safeParse(JSON.parse(await file.text()));
      if (!result.success)
        throw new Error(
          t('Проверьте формат пакета: {0}', [
            result.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join('.')}: ${t(issue.message)}`)
              .join('; '),
          ]),
        );
      setDraft(result.data);
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('Не удалось прочитать файл.'));
    } finally {
      setReading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api('/admin/content/import', importResultSchema, { body: draft });
      setMessage(
        result.status === 'unchanged'
          ? t('Эта версия уже загружена. Дубликаты не созданы.')
          : t('Пакет загружен: {0} маршрута, {1} уроков, {2} заданий.', [
              result.counts.routes,
              result.counts.lessons,
              result.counts.exercises,
            ]),
      );
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('Импорт не выполнен.'));
    } finally {
      setBusy(false);
    }
  }
  async function download(id: string) {
    setBusy(true);
    setError('');
    try {
      const data = await api(`/admin/content/packages/${id}/export`, contentPackageSchema);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${id}-v${data.package.version}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(failure instanceof Error ? t(failure.message) : t('Экспорт не выполнен.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link to="/admin">{t('← Кабинет суперадмина')}</Link>
      <h1>{t('Учебный контент')}</h1>
      <p>
        {t(
          'Импорт и экспорт пакетов JSON. Медиафайлы размещаются отдельно; пакет хранит их ссылки и описание. Экспорт включает правильные ответы.',
        )}
      </p>
      <form className="panel" onSubmit={(event) => void submit(event)}>
        <h2>{t('Импортировать пакет')}</h2>
        <label htmlFor="content-file">{t('Файл контента JSON')}</label>
        <input
          id="content-file"
          type="file"
          accept=".json,application/json"
          disabled={busy || reading}
          onChange={(event) => void select(event.target.files?.[0])}
        />
        {reading && <LoadingState text={t('Проверяем файл…')} />}
        {draft && (
          <p>
            {draft.package.title} {t(' · версия ')}
            {draft.package.version} · {draft.lessons.length} {t(' уроков ·')}{' '}
            {draft.exercises.length} {t(' заданий')}
          </p>
        )}
        <button disabled={!draft || busy || reading}>
          {busy ? t('Выполняем операцию…') : t('Импортировать пакет')}
        </button>
      </form>
      {error && (
        <p className="error inline-message" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="inline-message">
          {message}
        </p>
      )}
      <section className="panel">
        <h2>{t('Загруженные пакеты')}</h2>
        {state.status === 'loading' ? (
          <LoadingState />
        ) : state.status === 'error' ? (
          <ErrorState error={state.error} retry={refresh} />
        ) : state.data.length ? (
          <ul className="account-list">
            {state.data.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span>
                  {t('Версия ')}
                  {item.currentVersion}
                  {item.isDemo ? t(' · Демо') : ''}
                </span>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void download(item.id)}
                >
                  {t('Экспортировать ')}
                  {item.id}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={t('Пакеты пока не загружены')}
            description={t('Выберите подготовленный JSON-файл и импортируйте его.')}
          />
        )}
      </section>
      <Link to="/courses">{t('Просмотреть учебные маршруты →')}</Link>
    </>
  );
}
