import { t } from '../i18n';
import { errorText, locale } from '../i18n';
import { API_PREFIX, envelopeSchema, errorSchema } from '@luch/contracts';
import { z } from 'zod';
const meetingCsrf = new Map<string, string>();
export const setMeetingCsrf = (id: string, value: string | null) => {
  if (value) meetingCsrf.set(id, value);
  else meetingCsrf.delete(id);
};
const meetingTokenFor = (path: string) =>
  meetingCsrf.get(/^\/meetings\/([0-9a-f-]{36})(?:\/|$)/.exec(path)?.[1] ?? '');
let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly requestId?: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
export async function api<T extends z.ZodType>(
  path: string,
  schema: T,
  options: {
    signal?: AbortSignal;
    body?: unknown;
    keepalive?: boolean;
    timeoutMs?: number;
    loginCsrf?: string;
  } = {},
): Promise<z.infer<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 10000);
  try {
    const response = await fetch(`${API_PREFIX}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers:
        options.body === undefined
          ? { 'accept-language': locale }
          : {
              'content-type': 'application/json',
              'accept-language': locale,
              ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
              ...(options.loginCsrf ? { 'x-login-csrf': options.loginCsrf } : {}),
              ...(meetingTokenFor(path) ? { 'x-meeting-csrf': meetingTokenFor(path)! } : {}),
            },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
      credentials: 'same-origin',
      keepalive: options.keepalive ?? false,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      if (
        parsed.success &&
        ['BROWSER_CHECK_REQUIRED', 'BROWSER_INCOMPATIBLE'].includes(parsed.data.error.code)
      )
        window.dispatchEvent(new Event('luch:browser-check'));
      throw parsed.success
        ? new ApiError(
            errorText(t(parsed.data.error.message)),
            parsed.data.error.requestId,
            parsed.data.error.code,
            response.status,
          )
        : new ApiError(t('Сервис временно недоступен. Повторите попытку.'));
    }
    const result = envelopeSchema(z.unknown()).safeParse(payload);
    if (!result.success)
      throw new ApiError(t('Получен неполный ответ сервера. Повторите попытку.'));
    const data = schema.safeParse(result.data.data);
    if (!data.success) throw new ApiError(t('Получен неполный ответ сервера. Повторите попытку.'));
    return data.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      t('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'),
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function uploadMeetingFile(
  path: string,
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
) {
  const { meetingFileSchema } = await import('@luch/contracts');
  return new Promise<z.infer<typeof meetingFileSchema>>((resolve, reject) => {
    const xhr = new XMLHttpRequest(),
      abort = () => xhr.abort();
    xhr.open('POST', API_PREFIX + path);
    xhr.withCredentials = true;
    xhr.timeout = 30 * 60 * 1000;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('accept-language', locale);
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    const token = meetingTokenFor(path);
    if (token) xhr.setRequestHeader('x-meeting-csrf', token);
    const done = () => signal.removeEventListener('abort', abort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      done();
      try {
        const body: unknown = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = errorSchema.safeParse(body);
          reject(
            error.success
              ? new ApiError(
                  errorText(t(error.data.error.message)),
                  error.data.error.requestId,
                  error.data.error.code,
                  xhr.status,
                )
              : new ApiError(t('Не удалось загрузить файл. Повторите попытку.')),
          );
          return;
        }
        resolve(envelopeSchema(meetingFileSchema).parse(body).data);
      } catch {
        reject(new ApiError(t('Получен неполный ответ сервера. Повторите попытку.')));
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      done();
      reject(
        new ApiError(t('Не удалось загрузить файл. Проверьте соединение и повторите попытку.')),
      );
    };
    xhr.onabort = () => {
      done();
      reject(new ApiError(t('Загрузка файла отменена.')));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    xhr.send(file);
  });
}
