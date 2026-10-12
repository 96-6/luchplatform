import { API_PREFIX, envelopeSchema, errorSchema } from '@luch/contracts';
import { z } from 'zod';
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
  options: { signal?: AbortSignal; body?: unknown; keepalive?: boolean } = {},
): Promise<z.infer<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetch(`${API_PREFIX}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers:
        options.body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
            },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
      credentials: 'same-origin',
      keepalive: options.keepalive ?? false,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      throw parsed.success
        ? new ApiError(
            parsed.data.error.message,
            parsed.data.error.requestId,
            parsed.data.error.code,
            response.status,
          )
        : new ApiError('Сервис временно недоступен. Повторите попытку.');
    }
    const result = envelopeSchema(z.unknown()).safeParse(payload);
    if (!result.success) throw new ApiError('Получен неполный ответ сервера. Повторите попытку.');
    const data = schema.safeParse(result.data.data);
    if (!data.success) throw new ApiError('Получен неполный ответ сервера. Повторите попытку.');
    return data.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
