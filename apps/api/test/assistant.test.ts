import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assistantChatSchema,
  assistantProfileSchema,
  assistantVideoSchema,
  aiControlsSchema,
  aiCeilingsSchema,
  providerSettingsSchema,
  runViewSchema,
  type RunView,
} from '@luch/contracts';
import { learningFixture, failOn, type Login } from './helpers/learning.js';
import { AssistantService } from '../src/modules/assistant/service.js';
import { DemoAssistantAdapter } from '../src/modules/assistant/demo.js';
import { AvatarVideoService } from '../src/modules/assistant/video.js';
import { HeyGenAdapter } from '../src/modules/providers/heygen.js';
import { ProviderSettingsService } from '../src/modules/providers/settings.js';
import type { ProviderFetch } from '../src/modules/providers/adapters.js';

let f: Awaited<ReturnType<typeof learningFixture>>,
  calls: { url: string; body: unknown }[] = [];
let handler: (url: string, init?: RequestInit) => Promise<Response>;
const mp4 = Buffer.from([
  0,
  0,
  0,
  24,
  ...Buffer.from('ftypisom'),
  0,
  0,
  0,
  0,
  ...Buffer.from('isommp42'),
]);
const fake: ProviderFetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  return handler(url, init);
};
beforeAll(async () => {
  f = await learningFixture(fake);
});
beforeEach(async () => {
  await f.reset();
  calls = [];
  handler = async (url) =>
    url.endsWith('/videos')
      ? Response.json({ data: { video_id: 'demo-video-id' } })
      : url.includes('/v3/videos/')
        ? Response.json({
            data: {
              status: 'completed',
              video_url: 'https://resource.heygen.ai/test.mp4',
              duration: 12,
            },
          })
        : new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
});
afterAll(async () => {
  await f.app.close();
});
async function start(
  user: Login,
  language: 'ru' | 'en' = 'ru',
  purpose: 'practice' | 'control' | 'diagnostic' = 'practice',
) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: user.headers,
    payload: {
      packageId: 'luch-demo',
      source: { type: 'lesson', id: language === 'ru' ? 'rki-01' : 'english-01', purpose },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return runViewSchema.parse(response.json().data);
}
async function send(
  user: Login,
  run: RunView,
  action = 'explain',
  operationId = randomUUID(),
  text = '',
) {
  return f.app.inject({
    method: 'POST',
    url: `/api/v1/assistant/runs/${run.run.id}/messages`,
    headers: user.headers,
    payload: { turnId: run.current!.turn.id, operationId, action, text },
  });
}
async function chat(user: Login, run: RunView) {
  const response = await f.app.inject({
    url: `/api/v1/assistant/runs/${run.run.id}/messages`,
    headers: user.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return assistantChatSchema.parse(response.json().data);
}
async function configure(root: Login) {
  const settings = new ProviderSettingsService(f.db, f.crypto, f.settings);
  let config = await settings.read(root.actor);
  config = await settings.updateCeilings(root.actor, {
    revision: config.revision,
    ceilings: aiCeilingsSchema.parse({
      lifetimeMicros: 10_000_000,
      dailyMicros: 10_000_000,
      monthlyMicros: 10_000_000,
      perUserDailyMicros: 10_000_000,
      requestsPerUserDay: 50,
      maxVideoSeconds: 300,
      maxVideoCharacters: 1200,
    }),
  });
  const video = new AvatarVideoService(settings, new HeyGenAdapter(fake));
  await video.updateBindings(root.actor, {
    revision: 1,
    items: ['mentor', 'partner', 'guide'].map((id) => ({
      id: id as 'mentor' | 'partner' | 'guide',
      avatarId: `${id}-avatar`,
      voiceRu: `${id}-ru`,
      voiceEn: `${id}-en`,
    })),
  });
  config = await settings.read(root.actor);
  config = await settings.updateProvider(root.actor, 'heygen', {
    revision: config.providers.find((p) => p.id === 'heygen')!.revision,
    enabled: true,
    model: 'avatar_iv',
    voiceRu: '',
    voiceEn: '',
    inputRate: null,
    outputRate: null,
    characterRate: null,
    minuteRate: 1_000_000,
    confirmPricing: true,
    apiKey: randomBytes(24).toString('hex'),
    clearKey: false,
  });
  config = await settings.updateControls(root.actor, {
    revision: config.revision,
    controls: aiControlsSchema.parse({
      ...config.controls,
      videoEnabled: true,
      dailyMicros: 10_000_000,
      monthlyMicros: 10_000_000,
      perUserDailyMicros: 10_000_000,
      requestsPerUserDay: 50,
      maxVideoSeconds: 300,
      maxVideoCharacters: 1200,
    }),
  });
  return { settings, video, config };
}
async function message(user: Login, run: RunView) {
  const r = await send(user, run);
  expect(r.statusCode, r.body).toBe(200);
  return assistantChatSchema.parse(r.json().data).messages.at(-1)!.id;
}
async function prepare(user: Login, id: string) {
  return f.app.inject({
    method: 'POST',
    url: `/api/v1/assistant/messages/${id}/video/prepare`,
    headers: user.headers,
    payload: {},
  });
}
async function status(user: Login, id: string) {
  return f.app.inject({
    method: 'POST',
    url: `/api/v1/assistant/messages/${id}/video/status`,
    headers: user.headers,
    payload: {},
  });
}

describe('avatars and contextual demo assistant', () => {
  it('stores the chosen avatar and preferences with conflict protection', async () => {
    const user = await f.active();
    const r = await f.app.inject({ url: '/api/v1/assistant/profile', headers: user.headers });
    const p = assistantProfileSchema.parse(r.json().data);
    expect(p.avatars).toHaveLength(3);
    expect(p.revision).toBe(0);
    const payload = {
      revision: 0,
      preferences: {
        ...p.preferences,
        avatarId: 'partner',
        voiceAvatarId: 'guide',
        address: 'informal',
        pace: 'slow',
        detail: 'detailed',
        animation: false,
      },
    };
    const saved = await f.app.inject({
      method: 'POST',
      url: '/api/v1/assistant/profile',
      headers: user.headers,
      payload,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const again = await f.app.inject({ url: '/api/v1/assistant/profile', headers: user.headers });
    expect(again.json().data.preferences).toEqual(payload.preferences);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/assistant/profile',
          headers: user.headers,
          payload: { ...payload, preferences: p.preferences },
        })
      ).statusCode,
    ).toBe(409);
  });
  it.each(['ru', 'en'] as const)(
    'explains the current %s exercise and persists exactly one exchange on retries',
    async (language) => {
      const user = await f.active(),
        run = await start(user, language),
        operationId = randomUUID();
      const first = await send(user, run, 'explain', operationId),
        second = await send(user, run, 'explain', operationId);
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      const saved = await chat(user, run);
      expect(saved.label).toBe('Демо-помощник');
      expect(saved.messages).toHaveLength(2);
      expect(saved.messages[1]!.content).toContain(run.current!.exercise.instruction);
      expect(saved.context).toBeNull();
      expect((await send(user, run, 'hint', operationId)).statusCode).toBe(409);
      const row = (
        await f.db.query<{ context: { material: unknown[]; exercise: { id: string } } }>(
          'SELECT context FROM assistant_exchanges',
        )
      ).rows[0]!;
      expect(row.context.material.length).toBeGreaterThan(0);
      expect(row.context.exercise.id).toBe(run.current!.exercise.id);
      expect(JSON.stringify(row.context)).not.toContain('solution');
    },
  );
  it('records assistant help and hints in the same transaction as the exchange', async () => {
    const user = await f.active(),
      run = await start(user);
    expect((await send(user, run, 'hint')).statusCode).toBe(200);
    const v = await f.view(user, run.run.id);
    expect(v.current!.turn.assistantHelp).toBe(true);
    expect(v.current!.turn.usedHints).toHaveLength(1);
    const answered = await f.answer(user, v, true);
    expect(answered.attempts[0]!.independent).toBe(false);
    expect(answered.attempts[0]!.assistantHelp).toBe(true);
  });
  it('keeps feedback and theme dialogue linked to the submitted attempt', async () => {
    const user = await f.active(),
      run = await start(user),
      answered = await f.answer(user, run, false);
    const r = await send(user, answered);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('в ответе есть ошибка');
    const root = await f.active('superadmin'),
      debug = await chat(root, answered);
    expect(debug.context?.lastAttempt?.evaluation?.correct).toBe(false);
    const d = await send(user, answered, 'dialogue', randomUUID(), 'Здравствуйте');
    expect(d.statusCode, d.body).toBe(200);
    expect(d.body).toContain(run.run.title);
    expect((await f.view(user, run.run.id)).attempts[0]!.independent).toBe(true);
    const next = await f.next(user, answered);
    const newReply = await send(user, next);
    expect(newReply.statusCode, newReply.body).toBe(200);
    const moved = await chat(root, next);
    expect(moved.context?.lastAttempt?.id).toBe(answered.attempts[0]!.id);
    expect(moved.context?.lastAttempt?.exerciseId).toBe(run.current!.exercise.id);
    expect(moved.context?.exercise.id).toBe(next.current!.exercise.id);
    expect(moved.messages.at(-1)!.content).not.toContain('в ответе есть ошибка');
  });
  it.each(['control', 'diagnostic'] as const)(
    'blocks hints and dialogue for %s even through direct API calls',
    async (purpose) => {
      const user = await f.active(),
        run = await start(user, 'ru', purpose);
      for (const action of ['hint', 'dialogue'])
        expect((await send(user, run, action)).statusCode).toBe(403);
      expect(
        (await send(user, run, 'explain', randomUUID(), 'Подскажи правильный ответ')).statusCode,
      ).toBe(200);
      expect((await f.view(user, run.run.id)).current!.turn.assistantHelp).toBe(false);
      const root = await f.active('superadmin'),
        c = await chat(root, run);
      expect(c.context?.material).toEqual([]);
      expect(c.context?.lastAttempt).toBeNull();
      expect(JSON.stringify(c)).not.toContain('correctOptionIds');
    },
  );
  it('authorizes history, avatars, writes and CSRF on the server', async () => {
    const user = await f.active(),
      other = await f.active(),
      teacher = await f.active('teacher'),
      root = await f.active('superadmin'),
      run = await start(user);
    await message(user, run);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/assistant/runs/${run.run.id}/messages`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      user.actor.user.id,
    ]);
    expect((await chat(teacher, run)).messages).toHaveLength(2);
    expect((await send(teacher, run)).statusCode).toBe(403);
    const res = await send(root, run);
    expect(res.statusCode, res.body).toBe(200);
    expect((await chat(root, run)).messages.at(-1)!.actorId).toBe(root.actor.user.id);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/assistant/profile',
          headers: { cookie: user.headers.cookie },
          payload: { revision: 0, preferences: {} },
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.app.inject({ url: '/api/v1/assistant/profile' })).statusCode).toBe(401);
  });
  it('rejects stale turns and rolls back messages and help when persistence fails', async () => {
    const user = await f.active(),
      run = await start(user);
    const service = new AssistantService(failOn(f.db, 'INSERT INTO assistant_exchanges'));
    await expect(
      service.send(user.actor, run.run.id, {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        action: 'hint',
        text: '',
      }),
    ).rejects.toThrow();
    expect((await chat(user, run)).messages).toHaveLength(0);
    expect((await f.view(user, run.run.id)).current!.turn.assistantHelp).toBe(false);
    const answered = await f.answer(user, run, true);
    await f.next(user, answered);
    expect((await send(user, run)).statusCode).toBe(409);
  });
  it('returns no partial exchange after a handler failure', async () => {
    const user = await f.active(),
      run = await start(user),
      adapter = new DemoAssistantAdapter();
    adapter.reply = async () => {
      throw new Error('temporary handler failure');
    };
    await expect(
      new AssistantService(f.db, adapter).send(user.actor, run.run.id, {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        action: 'explain',
        text: '',
      }),
    ).rejects.toThrow();
    expect((await chat(user, run)).messages).toHaveLength(0);
  });
});
describe('HeyGen generation, shared finance and persistent video cache', () => {
  it('creates once, polls, downloads and serves protected cached video after manual disable', async () => {
    const root = await f.active('superadmin'),
      user = await f.active(),
      other = await f.active();
    const { settings } = await configure(root);
    const run = await start(user),
      id = await message(user, run);
    const created = await prepare(user, id);
    expect(created.statusCode, created.body).toBe(200);
    expect(assistantVideoSchema.parse(created.json().data).status).toBe('pending');
    expect((await prepare(user, id)).statusCode).toBe(200);
    expect(calls.filter((c) => c.url.endsWith('/videos'))).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      type: 'avatar',
      avatar_id: 'mentor-avatar',
      voice_id: 'mentor-ru',
      engine: { type: 'avatar_iv' },
    });
    const polled = await status(user, id);
    expect(polled.statusCode, polled.body).toBe(200);
    const video = assistantVideoSchema.parse(polled.json().data);
    expect(video.status).toBe('ready');
    expect((await f.app.inject({ url: video.url!, headers: other.headers })).statusCode).toBe(404);
    const bytes = await f.app.inject({
      url: video.url!,
      headers: { ...user.headers, range: 'bytes=0-11' },
    });
    expect(bytes.statusCode, bytes.body).toBe(206);
    expect(bytes.rawPayload).toEqual(mp4.subarray(0, 12));
    let config = await settings.read(root.actor);
    config = await settings.updateControls(root.actor, {
      revision: config.revision,
      controls: { ...config.controls, videoEnabled: false },
    });
    expect(assistantVideoSchema.parse((await prepare(user, id)).json().data).cached).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/videos'))).toHaveLength(1);
    const ledger = await settings.requests(root.actor);
    expect(ledger.items[0]!.status).toBe('success');
    expect(ledger.items[0]!.chargedMicros).toBe(200_000);
  });
  it('uses a shared cached reply for another learner even when funds are zero', async () => {
    const root = await f.active('superadmin'),
      a = await f.active(),
      b = await f.active();
    const { settings } = await configure(root);
    const id = await message(a, await start(a));
    await prepare(a, id);
    await status(a, id);
    const cfg = await settings.read(root.actor);
    await settings.updateCeilings(root.actor, {
      revision: cfg.revision,
      ceilings: { ...cfg.ceilings, lifetimeMicros: 0 },
    });
    const second = await message(b, await start(b));
    const r = await prepare(b, second);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toMatchObject({ status: 'ready', cached: true });
    expect(calls.filter((c) => c.url.endsWith('/videos'))).toHaveLength(1);
  });
  it('retains a paid reservation through restart and status timeouts, without a second creation', async () => {
    const root = await f.active('superadmin'),
      user = await f.active();
    const { settings } = await configure(root),
      id = await message(user, await start(user));
    await prepare(user, id);
    handler = async () => {
      throw new Error('network timeout');
    };
    await status(user, id);
    expect((await settings.requests(root.actor)).items[0]!.status).toBe('reserved');
    await f.db.query("UPDATE avatar_video_jobs SET next_poll_at=now()-interval '1 minute'");
    handler = async (url) =>
      url.includes('/v3/videos/')
        ? Response.json({
            data: {
              status: 'completed',
              video_url: 'https://resource.heygen.ai/test.mp4',
              duration: 12,
            },
          })
        : new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
    const reopened = new AvatarVideoService(
      new ProviderSettingsService(f.db, f.crypto, f.settings),
      new HeyGenAdapter(fake),
    );
    expect((await reopened.status(user.actor, id)).status).toBe('ready');
    expect(calls.filter((c) => c.url.endsWith('/videos'))).toHaveLength(1);
  });
  it('reports exhausted credits with no attempt and no uncertain refund', async () => {
    const root = await f.active('superadmin'),
      user = await f.active();
    const { settings } = await configure(root),
      run = await start(user),
      id = await message(user, run);
    handler = async () => new Response('{}', { status: 402 });
    const r = await prepare(user, id);
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error.code).toBe('CONTENT_GENERATION_UNAVAILABLE');
    expect((await f.view(user, run.run.id)).attempts).toHaveLength(0);
    expect((await settings.requests(root.actor)).items[0]).toMatchObject({
      status: 'failed',
      chargedMicros: 0,
      errorCode: 'HEYGEN_CREDITS_EXHAUSTED',
    });
  });
  it('retains ambiguous creation costs and never silently submits twice', async () => {
    const root = await f.active('superadmin'),
      user = await f.active();
    const { settings } = await configure(root),
      id = await message(user, await start(user));
    handler = async () => {
      throw new Error('response lost after create');
    };
    expect((await prepare(user, id)).statusCode).toBe(503);
    await prepare(user, id);
    expect(calls.filter((c) => c.url.endsWith('/videos'))).toHaveLength(1);
    expect((await settings.requests(root.actor)).items[0]!.status).toBe('unknown');
    expect((await settings.read(root.actor)).spend.lifetimeMicros).toBeGreaterThan(0);
  });
  it('blocks controls, keys and avatar mappings for ordinary administrators', async () => {
    const root = await f.active('superadmin'),
      admin = await f.active('admin');
    await configure(root);
    expect(
      (await f.app.inject({ url: '/api/v1/admin/assistant/avatars', headers: admin.headers }))
        .statusCode,
    ).toBe(403);
    const cfg = providerSettingsSchema.parse(
      (await f.app.inject({ url: '/api/v1/admin/providers', headers: admin.headers })).json().data,
    );
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/controls',
      headers: admin.headers,
      payload: { revision: cfg.revision, controls: { ...cfg.controls, videoEnabled: false } },
    });
    expect(r.statusCode, r.body).toBe(403);
    expect(JSON.stringify(cfg)).not.toContain('credential');
  });
  it('blocks budget overrun and turns off future paid calls', async () => {
    const root = await f.active('superadmin'),
      user = await f.active();
    const { settings } = await configure(root),
      id = await message(user, await start(user));
    await prepare(user, id);
    handler = async (url) =>
      url.includes('/v3/videos/')
        ? Response.json({
            data: {
              status: 'completed',
              video_url: 'https://resource.heygen.ai/test.mp4',
              duration: 500,
            },
          })
        : new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
    expect((await status(user, id)).json().data.status).toBe('ready');
    expect((await settings.requests(root.actor)).items[0]!.status).toBe('overrun');
    expect((await settings.read(root.actor)).controls.videoEnabled).toBe(false);
  });
});

describe('unseen cached content and exhaustion', () => {
  async function correction(user: Login, finish: boolean) {
    const p = await f.preparedPlan(user),
      run = await f.start(user, p.plan.id, p.assignments[0]!.id);
    if (finish) await f.finish(user, run.run.id, [false, false]);
    else await f.answer(user, run, false);
    const plan = await f.plan(user, p.plan.id),
      assignment = plan.assignments.find((a) => a.kind === 'correction')!;
    return { plan, assignment };
  }
  it('delivers an unseen bank item while new generation is manually disabled', async () => {
    const user = await f.active(),
      { plan, assignment } = await correction(user, false);
    const run = await f.start(user, plan.plan.id, assignment.id);
    const previous = (
      await f.db.query<{ exercise_id: string }>(
        'SELECT s.exercise_id FROM engine_attempts a JOIN engine_steps s ON s.id=a.step_id WHERE a.user_id=$1 ORDER BY a.evaluated_at DESC LIMIT 1',
        [user.actor.user.id],
      )
    ).rows[0]!;
    expect(run.current!.exercise.id).not.toBe(previous.exercise_id);
    expect(run.run.cachedContent).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('returns a content-generation error after all relevant bank items were viewed', async () => {
    const user = await f.active(),
      { plan, assignment } = await correction(user, true);
    const before = (
      await f.db.query('SELECT * FROM engine_attempts WHERE user_id=$1', [user.actor.user.id])
    ).rows.length;
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.plan.id}/assignments/${assignment.id}/start`,
      headers: user.headers,
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error.code).toBe('CONTENT_GENERATION_UNAVAILABLE');
    expect(r.json().error.message).toContain('уже просмотрены');
    expect(
      (await f.db.query('SELECT * FROM engine_attempts WHERE user_id=$1', [user.actor.user.id]))
        .rows,
    ).toHaveLength(before);
    expect(
      (await f.plan(user, plan.plan.id)).assignments.find((a) => a.id === assignment.id)!.runId,
    ).toBeNull();
  });
  it('reuses a relevant generated variant for another learner when generation is disabled', async () => {
    const root = await f.active('superadmin'),
      first = await f.active(),
      second = await f.active(),
      settings = new ProviderSettingsService(f.db, f.crypto, f.settings);
    let config = await settings.read(root.actor);
    config = await settings.updateCeilings(root.actor, {
      revision: config.revision,
      ceilings: aiCeilingsSchema.parse({
        lifetimeMicros: 10_000_000,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 30,
      }),
    });
    config = await settings.updateProvider(root.actor, 'openai', {
      revision: config.providers.find((p) => p.id === 'openai')!.revision,
      enabled: true,
      model: 'demo-model',
      voiceRu: '',
      voiceEn: '',
      inputRate: 100000,
      outputRate: 400000,
      characterRate: null,
      minuteRate: null,
      confirmPricing: true,
      apiKey: randomBytes(24).toString('hex'),
      clearKey: false,
    });
    config = await settings.updateControls(root.actor, {
      revision: config.revision,
      controls: aiControlsSchema.parse({
        ...config.controls,
        enabled: true,
        dailyMicros: 10_000_000,
        monthlyMicros: 10_000_000,
        perUserDailyMicros: 10_000_000,
        requestsPerUserDay: 30,
      }),
    });
    handler = async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                instruction: 'Выберите приветствие для новой встречи.',
                material: 'Новая встреча с коллегой.',
                options: [
                  { id: 'a', text: 'До свидания' },
                  { id: 'b', text: 'Здравствуйте' },
                  { id: 'c', text: 'Вчера' },
                ],
                correctOptionId: 'b',
                explanation: 'Здравствуйте — вежливое приветствие.',
                hint: 'Вспомните начало разговора.',
                listeningText: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      });
    const a = await correction(first, true),
      original = await f.start(first, a.plan.plan.id, a.assignment.id);
    expect(original.current!.generatedExerciseId).not.toBeNull();
    config = await settings.read(root.actor);
    await settings.updateControls(root.actor, {
      revision: config.revision,
      controls: { ...config.controls, enabled: false },
    });
    const b = await correction(second, true),
      cached = await f.start(second, b.plan.plan.id, b.assignment.id);
    expect(cached.current!.generatedExerciseId).toBe(original.current!.generatedExerciseId);
    expect(cached.run.cachedContent).toBe(true);
    expect(calls).toHaveLength(1);
    const again = await f.start(second, b.plan.plan.id, b.assignment.id);
    expect(again.run.id).toBe(cached.run.id);
    expect(calls).toHaveLength(1);
  });
});
