import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  speechSessionSchema,
  speechInputSchema,
  speechConfirmationSchema,
  runViewSchema,
  type RunView,
  type SpeechInput,
  type speechUploadSchema,
  type speechConfirmSchema,
  type speechTextSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import { api, ApiError } from '../lib/api';
import { audioBase64, PcmRecorder } from '../lib/recorder';
import { AssistantReplyAudio } from './AssistantReplyAudio';
type Pending =
  | { kind: 'upload'; body: z.infer<typeof speechUploadSchema> }
  | { kind: 'retry'; id: string; operationId: string }
  | { kind: 'confirm'; id: string; body: z.infer<typeof speechConfirmSchema> }
  | { kind: 'text'; body: z.infer<typeof speechTextSchema> }
  | { kind: 'discard'; id: string };
type Assignment = z.infer<typeof speechConfirmationSchema>['assignment'];
export function VoiceAnswer({
  view,
  editable,
  changed,
  refresh,
  onBusy,
}: {
  view: RunView;
  editable: boolean;
  changed: (v: RunView) => void;
  refresh: () => Promise<void>;
  onBusy: (value: boolean) => void;
}) {
  const [session, setSession] = useState<z.infer<typeof speechSessionSchema> | null>(null),
    [input, setInput] = useState<SpeechInput | null>(null),
    [text, setText] = useState(''),
    [optionId, setOptionId] = useState(''),
    [fallback, setFallback] = useState(false);
  const [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState(''),
    [assignment, setAssignment] = useState<Assignment>(null),
    [autoSpeak, setAutoSpeak] = useState(false);
  const recorder = useRef<PcmRecorder | null>(null),
    pending = useRef<Pending | null>(null),
    mounted = useRef(true),
    controller = useRef(new AbortController()),
    navigate = useNavigate();
  const base = `/engine/runs/${view.run.id}/speech`,
    turnId = view.current!.turn.id;
  const answered = Boolean(view.current!.attempt),
    canAnswer = editable && !answered;
  function updateInput(value: SpeechInput | null) {
    setInput(value);
    if (value) setText(value.confirmedText ?? value.transcript ?? '');
  }
  async function load() {
    const data = await api(base, speechSessionSchema, { signal: controller.current.signal });
    if (!mounted.current) return;
    if (data.turnId !== turnId) {
      await refresh();
      return;
    }
    setSession(data);
    updateInput(data.input);
    if (data.input?.status === 'confirmed') {
      const result = await api(`${base}/inputs/${data.input.id}/result`, speechConfirmationSchema, {
        signal: controller.current.signal,
      });
      if (mounted.current) setAssignment(result.assignment);
    }
  }
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    void load().catch((e) => {
      if (mounted.current) setError((e as Error).message);
    });
    return () => {
      mounted.current = false;
      controller.current.abort();
      recorder.current?.cancel();
      onBusy(false);
    };
  }, [base, turnId]);
  useEffect(() => {
    if (input?.status !== 'processing') return;
    const timer = setTimeout(() => {
      void load().catch((e) => setError((e as Error).message));
    }, 1500);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setSeconds((s) => Math.min(session?.maxSeconds ?? 30, s + 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [recording, session?.maxSeconds]);
  async function perform(action: Pending) {
    pending.current = action;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      let value: SpeechInput;
      if (action.kind === 'confirm' || action.kind === 'text') {
        const result = await api(
          action.kind === 'text' ? `${base}/text` : `${base}/inputs/${action.id}/confirm`,
          speechConfirmationSchema,
          { body: action.body, signal: controller.current.signal },
        );
        value = result.input;
        if (mounted.current) {
          setAssignment(result.assignment);
          setAutoSpeak(true);
          changed(result.view);
        }
      } else if (action.kind === 'upload')
        value = await api(`${base}/inputs`, speechInputSchema, {
          body: action.body,
          timeoutMs: 30000,
          signal: controller.current.signal,
        });
      else if (action.kind === 'retry')
        value = await api(`${base}/inputs/${action.id}/retry`, speechInputSchema, {
          body: { operationId: action.operationId },
          timeoutMs: 30000,
          signal: controller.current.signal,
        });
      else
        value = await api(`${base}/inputs/${action.id}/discard`, speechInputSchema, {
          body: {},
          signal: controller.current.signal,
        });
      pending.current = null;
      if (mounted.current) {
        if (value.status === 'discarded') {
          setInput(null);
          setText('');
          setOptionId('');
        } else updateInput(value);
      }
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && e.status && e.status < 500) {
          pending.current = null;
          if (e.code === 'TURN_CHANGED' || e.code === 'ANSWER_ALREADY_SAVED') await refresh();
        }
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  async function start() {
    if (!session?.enabled || busy || recording || !canAnswer) return;
    setError('');
    setSeconds(0);
    setBusy(true);
    onBusy(true);
    setAutoSpeak(false);
    const capture = new PcmRecorder(session.maxSeconds);
    recorder.current = capture;
    try {
      await capture.start();
      if (!mounted.current) return;
      setRecording(true);
      setBusy(false);
      void capture.result
        .then((bytes) => {
          if (mounted.current) {
            setRecording(false);
            void perform({
              kind: 'upload',
              body: { turnId, operationId: crypto.randomUUID(), audioBase64: audioBase64(bytes) },
            });
          }
        })
        .catch((e) => {
          if (mounted.current && recorder.current === capture) {
            setRecording(false);
            setBusy(false);
            onBusy(false);
            setError((e as Error).message);
            setFallback(true);
          }
        });
    } catch (e) {
      if (mounted.current) {
        setRecording(false);
        setBusy(false);
        onBusy(false);
        setFallback(true);
        setError(
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Доступ к микрофону не разрешён. Разрешите его в браузере или введите реплику текстом.'
            : (e as Error).message,
        );
      }
    }
  }
  async function openAssignment() {
    if (!assignment) return;
    setBusy(true);
    setError('');
    try {
      const result = await api(
        `/plans/${assignment.planId}/assignments/${assignment.id}/start`,
        runViewSchema,
        { body: {} },
      );
      navigate(`/learning/runs/${result.run.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const choice =
    view.current!.exercise.response.type === 'choice'
      ? view.current!.exercise.response.options
      : [];
  const needConfirmation = input?.status === 'ready';
  return (
    <section className="panel voice-answer" aria-label="Голосовой ответ">
      <h2>Голосовой ответ</h2>
      <p className="muted">
        Сначала проверьте распознанную реплику. Оценивается подтверждённый текст, а не произношение.
        Технический сбой не снижает учебную оценку.
      </p>
      {canAnswer && (
        <>
          {!session && <p role="status">Проверяем доступность записи…</p>}
          {session && !session.enabled && (
            <p>Распознавание пока недоступно. Можно ответить текстом.</p>
          )}
          {recording ? (
            <div>
              <p role="status">
                Идёт запись: {seconds} из {session?.maxSeconds} сек.
              </p>
              <button onClick={() => recorder.current?.stop()}>Завершить запись</button>
              <button
                className="secondary"
                onClick={() => {
                  const capture = recorder.current;
                  recorder.current = null;
                  capture?.cancel();
                  setRecording(false);
                  setBusy(false);
                  onBusy(false);
                }}
              >
                Отменить запись
              </button>
            </div>
          ) : (
            <button
              disabled={
                busy ||
                !session?.enabled ||
                input?.status === 'processing' ||
                Boolean(pending.current) ||
                needConfirmation
              }
              onClick={() => void start()}
            >
              {busy ? 'Обрабатываем реплику…' : 'Начать запись'}
            </button>
          )}
          {!recording && (
            <button
              className="secondary"
              disabled={busy || Boolean(pending.current)}
              onClick={() => {
                setFallback(true);
                setError('');
              }}
            >
              Ввести реплику текстом
            </button>
          )}
        </>
      )}
      {(busy || input?.status === 'processing') && !recording && (
        <p role="status">
          {input?.status === 'processing'
            ? 'Распознаём запись через ElevenLabs…'
            : 'Сохраняем реплику…'}
        </p>
      )}
      {input?.error && (
        <div role="alert" className="error">
          <p>{input.error}</p>
          {canAnswer && input.canRetry && (
            <button
              disabled={busy}
              onClick={() =>
                void perform({ kind: 'retry', id: input.id, operationId: crypto.randomUUID() })
              }
            >
              Повторить распознавание
            </button>
          )}
        </div>
      )}
      {canAnswer && input && ['ready', 'error'].includes(input.status) && (
        <button
          className="secondary"
          disabled={busy || Boolean(pending.current)}
          onClick={() => void perform({ kind: 'discard', id: input.id })}
        >
          Записать заново
        </button>
      )}
      {canAnswer && (needConfirmation || fallback) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const body = {
              operationId: crypto.randomUUID(),
              text,
              ...(optionId ? { optionId } : {}),
            };
            void perform(
              needConfirmation && !fallback
                ? { kind: 'confirm', id: input!.id, body }
                : { kind: 'text', body: { ...body, turnId } },
            );
          }}
        >
          <fieldset disabled={busy || recording || Boolean(pending.current)}>
            <label htmlFor={`voice-text-${turnId}`}>
              {needConfirmation && !fallback ? 'Распознанная реплика' : 'Текст реплики'}
            </label>
            <textarea
              id={`voice-text-${turnId}`}
              maxLength={1000}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
            {choice.length > 0 && (
              <>
                <label htmlFor={`voice-option-${turnId}`}>Вариант ответа по реплике</label>
                <select
                  id={`voice-option-${turnId}`}
                  value={optionId}
                  onChange={(e) => setOptionId(e.target.value)}
                >
                  <option value="">Определить по точному тексту реплики</option>
                  {choice.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.text}
                    </option>
                  ))}
                </select>
                <p className="muted">
                  Если распознанный текст не совпадает с вариантом, выберите его сами перед
                  проверкой.
                </p>
              </>
            )}
            <button disabled={!text.trim()}>
              {needConfirmation && !fallback
                ? 'Подтвердить реплику и проверить'
                : 'Отправить текстовый ответ'}
            </button>
          </fieldset>
        </form>
      )}
      {input?.status === 'confirmed' && (
        <div className="voice-feedback" role="status">
          <p>
            <strong>
              {input.source === 'voice' ? 'Подтверждённая реплика' : 'Текстовый ответ'}:
            </strong>{' '}
            {input.confirmedText}
          </p>
          {input.edited && <p className="muted">Распознанный текст исправлен перед проверкой.</p>}
          <p>
            <strong>
              {view.current?.attempt?.teacherReview
                ? 'Первоначальный ответ демо-помощника:'
                : 'Демо-помощник:'}
            </strong>{' '}
            {input.reply}
          </p>
          {input.messageId && (
            <AssistantReplyAudio
              key={input.messageId}
              messageId={input.messageId}
              editable={editable}
              auto={autoSpeak && Boolean(session?.ttsEnabled)}
            />
          )}
          {assignment && (
            <div>
              <p>
                {assignment.kind === 'review' ? 'Назначено повторение' : 'Следующее упражнение'}:{' '}
                {assignment.title}
              </p>
              {assignment.dueAt && (
                <p>Доступно с {new Date(assignment.dueAt).toLocaleString('ru-RU')}</p>
              )}
              {(!assignment.dueAt || new Date(assignment.dueAt).getTime() <= Date.now()) &&
                editable && (
                  <button disabled={busy} onClick={() => void openAssignment()}>
                    Открыть назначенное упражнение
                  </button>
                )}
              <p>
                <Link to={`/plan/${assignment.planId}#assignment-${assignment.id}`}>
                  Назначение и причина в плане →
                </Link>
              </p>
            </div>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="error">
          <p>{error}</p>
          <p>Можно продолжить с текстовым ответом. Техническая ошибка не считается учебной.</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (pending.current) void perform(pending.current);
              else void load().catch((e) => setError((e as Error).message));
            }}
          >
            Повторить операцию
          </button>
          {pending.current && !busy && (
            <button
              className="secondary"
              onClick={() => {
                pending.current = null;
                setError('');
                setFallback(true);
              }}
            >
              Перейти к текстовому вводу
            </button>
          )}
        </div>
      )}
    </section>
  );
}
