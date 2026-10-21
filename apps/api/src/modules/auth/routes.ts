import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginSchema,
  registerSchema,
  verificationSchema,
  enrollmentConfirmSchema,
  networkEvidenceSchema,
  captchaInputSchema,
  loginConfirmSchema,
  passwordRequestSchema,
  passwordResetSchema,
  passwordChangeSchema,
} from '@luch/contracts';
import type { AuthService } from './service.js';
import type { CaptchaService } from '../security/captcha.js';
import { limitAttempts } from '../security/rate.js';
import { getPolicy } from '../security/policy.js';
import { AppError } from '../../errors.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  captcha: CaptchaService,
) {
  app.get('/api/v1/security/bootstrap', async (request) => {
    const policy = await getPolicy(auth.database);
    return {
      data: {
        captchaEnabled: policy.captchaEnabled,
        networkChecksEnabled: policy.vpnCheckEnabled,
        localMailboxEnabled:
          auth.settings.APP_ENV !== 'production' &&
          auth.settings.ENABLE_DEV_TOOLS &&
          auth.settings.MAIL_MODE === 'local',
        probeTargets: policy.vpnCheckEnabled ? auth.network.probeTargets() : [],
        stunUrls: policy.vpnCheckEnabled ? auth.network.stunUrls() : [],
      },
      requestId: request.id,
    };
  });
  app.get('/api/v1/security/ping', async (request) => ({
    data: { message: 'ok' },
    requestId: request.id,
  }));
  app.post('/api/v1/security/evaluate', async (request, reply) => {
    await limitAttempts(auth.database, auth.crypto, `network:${request.ip}`, 60);
    return {
      data: await auth.network.evaluate(request, reply, networkEvidenceSchema.parse(request.body)),
      requestId: request.id,
    };
  });
  app.get('/api/v1/auth/captcha', async (request) => {
    const query = z
      .object({ purpose: z.enum(['login', 'register', 'enrollment', 'password']) })
      .parse(request.query);
    return { data: await captcha.issue(request.ip, query.purpose), requestId: request.id };
  });
  app.post('/api/v1/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `register-ip:${request.ip}`, 20);
    await limitAttempts(auth.database, auth.crypto, `register-email:${input.email}`, 5);
    await auth.network.check(request);
    await captcha.check(request.ip, 'register', input.captcha);
    return reply.code(202).send({ data: await auth.register(input), requestId: request.id });
  });
  app.post('/api/v1/auth/verify-email', async (request, reply) => {
    await limitAttempts(auth.database, auth.crypto, `email-verify:${request.ip}`, 20);
    await auth.network.check(request);
    await auth.verifyEmail(verificationSchema.parse(request.body).token, reply);
    return { data: { message: 'Почта подтверждена.' }, requestId: request.id };
  });
  app.get('/api/v1/auth/enrollment', async (request) => ({
    data: await auth.enrollment(request),
    requestId: request.id,
  }));
  app.post('/api/v1/auth/enrollment/confirm', async (request, reply) => {
    const input = enrollmentConfirmSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `enrollment:${request.ip}`, 10);
    await auth.network.check(request);
    await captcha.check(request.ip, 'enrollment', input.captcha);
    return {
      data: await auth.confirmEnrollment(request, reply, input.code),
      requestId: request.id,
    };
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    await limitAttempts(auth.database, auth.crypto, `login-ip:${request.ip}`, 40);
    const raw = z
      .strictObject({
        email: z.string().trim().max(254),
        password: z.string().max(128).optional(),
        code: z.string().max(20).optional(),
        captcha: captchaInputSchema.optional(),
      })
      .safeParse(request.body);
    if (!raw.success) throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль.');
    const local = !raw.data.password
      ? await auth.localLogin(request, reply, raw.data.email, raw.data.code ?? '')
      : null;
    if (local) return { data: local, requestId: request.id };
    const parsed = loginSchema.safeParse(raw.data);
    if (!parsed.success)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль.');
    const input = parsed.data;
    await limitAttempts(auth.database, auth.crypto, `login-email:${input.email}`, 5);
    await captcha.check(request.ip, 'login', input.captcha);
    return {
      data: await auth.login(request, reply, input.email, input.password),
      requestId: request.id,
    };
  });
  app.get('/api/v1/auth/login/challenge', async (request, reply) => ({
    data: await auth.loginChallenge(request, reply),
    requestId: request.id,
  }));
  app.post('/api/v1/auth/login/confirm', async (request, reply) => {
    const input = loginConfirmSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `login-confirm:${request.ip}`, 40);
    return { data: await auth.confirmLogin(request, reply, input.code), requestId: request.id };
  });
  app.post('/api/v1/auth/password/request', async (request, reply) => {
    const input = passwordRequestSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `password-ip:${request.ip}`, 20);
    await limitAttempts(auth.database, auth.crypto, `password-email:${input.email}`, 5);
    await auth.network.check(request);
    await captcha.check(request.ip, 'password', input.captcha);
    return reply
      .code(202)
      .send({ data: await auth.requestPassword(input.email), requestId: request.id });
  });
  app.post('/api/v1/auth/password/reset', async (request, reply) => {
    const input = passwordResetSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `password-reset:${request.ip}`, 20);
    await auth.network.check(request);
    return {
      data: await auth.resetPassword(input.token, input.password, reply),
      requestId: request.id,
    };
  });
  app.post('/api/v1/auth/password/change', async (request, reply) => {
    const actor = await auth.requireActor(request, undefined, true);
    const input = passwordChangeSchema.parse(request.body);
    await limitAttempts(auth.database, auth.crypto, `password-change:${actor.user.id}`, 5);
    return {
      data: await auth.changePassword(
        actor,
        input.currentPassword,
        input.password,
        input.code,
        reply,
      ),
      requestId: request.id,
    };
  });
  app.get('/api/v1/auth/session', async (request, reply) => ({
    data: await auth.session(request, reply),
    requestId: request.id,
  }));
  app.post('/api/v1/auth/logout', async (request, reply) => ({
    data: await auth.logout(request, reply),
    requestId: request.id,
  }));
  if (
    auth.settings.APP_ENV !== 'production' &&
    auth.settings.ENABLE_DEV_TOOLS &&
    auth.settings.MAIL_MODE === 'local'
  ) {
    app.get('/api/v1/dev/mail', async (request) => {
      const query = z.object({ email: z.email() }).parse(request.query);
      return { data: await auth.mail.localInbox(query.email), requestId: request.id };
    });
  }
}
