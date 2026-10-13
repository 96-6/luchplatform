import type { FastifyRequest } from 'fastify';
import type { Settings } from '../../config.js';
import { normalizeIp } from '../security/policy.js';

export function localDebugRequest(settings: Settings, request: FastifyRequest) {
  if (
    !settings.LOCAL_DEBUG_LOGIN ||
    settings.APP_ENV === 'production' ||
    !settings.ENABLE_DEV_TOOLS
  )
    return false;
  const remote = request.raw.socket.remoteAddress;
  if (
    !remote ||
    !['127.0.0.1', '::1'].includes(normalizeIp(remote)) ||
    !['127.0.0.1', '::1'].includes(normalizeIp(request.ip))
  )
    return false;
  if (
    ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'].some(
      (header) => request.headers[header] !== undefined,
    )
  )
    return false;
  const host = request.headers.host;
  if (!host || !URL.canParse(`http://${host}`)) return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname);
}
