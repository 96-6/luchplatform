import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  providerSettingsSchema,
  runViewSchema,
  aiCeilingsSchema,
  aiControlsSchema,
  updateProviderSchema,
} from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
import { ContentService } from '../src/modules/content/service.js';
import { LuchEngine } from '../src/modules/engine/service.js';
import { GenerationService } from '../src/modules/providers/generation.js';
import { ProviderSettingsService } from '../src/modules/providers/settings.js';
import { TextGenerationAdapter, type ProviderFetch } from '../src/modules/providers/adapters.js';

let f: Awaited<ReturnType<typeof learningFixture>>,
  calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [],
  handler: (url: string, body: Record<string, unknown>) => Promise<Response>;
const question = {
  instruction: 'Выберите вежливое приветствие.',
  material: 'Короткая ситуация знакомства.',
  options: [
    { id: 'a', text: 'До свидания' },
    { id: 'b', text: 'Здравствуйте' },
    { id: 'c', text: 'Вчера' },
  ],
  correctOptionId: 'b',
  explanation: 'Здравствуйте — вежливое приветствие.',
  hint: 'Вспомните начало вежливого разговора.',
  listeningText: null,
};
const completion = (value: unknown = question, input = 200, output = 100) =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output },
  });
const fakeFetch: ProviderFetch = async (input, init) => {
  const url = String(input),
    body = JSON.parse(String(init?.body)) as Record<string, unknown>,
    headers = new Headers(init?.headers);
  calls.push({ url, body, headers });
  return handler(url, body);
};
beforeAll(async () => {
  f = await learningFixture(fakeFetch);
});
beforeEach(async () => {
  await f.reset();
  calls = [];
  handler = async () => completion();
});
afterAll(async () => {
  await f.app.close();
});
async function read(user: Login) {
  const r = await f.app.inject({ url: '/api/v1/admin/providers', headers: user.headers });
  expect(r.statusCode, r.body).toBe(200);
  return providerSettingsSchema.parse(r.json().data);
}
async function controls(root: Login, changes: Record<string, unknown> = {}) {
  const current = await read(root),
    r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/controls',
      headers: root.headers,
      payload: { revision: current.revision, controls: { ...current.controls, ...changes } },
    });
  expect(r.statusCode, r.body).toBe(200);
  return providerSettingsSchema.parse(r.json().data);
}
async function configure(
  root: Login,
  options: { neuro?: boolean; speech?: boolean; withListening?: boolean } = {},
) {
  let config = await read(root);
  const ceilings = aiCeilingsSchema.parse({
    lifetimeMicros: 10_000_000,
    dailyMicros: 10_000_000,
    monthlyMicros: 10_000_000,
    perUserDailyMicros: 10_000_000,
    requestsPerUserDay: 20,
    maxTtsCharacters: 2000,
    maxOutputTokens: 1024,
    maxConcurrent: 2,
  });
  const ceiling = await f.app.inject({
    method: 'POST',
    url: '/api/v1/admin/providers/ceilings',
    headers: root.headers,
    payload: { revision: config.revision, ceilings },
  });
  expect(ceiling.statusCode, ceiling.body).toBe(200);
  config = providerSettingsSchema.parse(ceiling.json().data);
  for (const id of [
    'openai',
    ...(options.neuro ? ['neuroapi'] : []),
    ...(options.speech ? ['elevenlabs'] : []),
  ] as const) {
    const key = randomBytes(24).toString('hex');
    const update = await f.app.inject({
      method: 'POST',
      url: `/api/v1/admin/providers/${id}`,
      headers: root.headers,
      payload: {
        revision: config.providers.find((p) => p.id === id)!.revision,
        enabled: true,
        model: id === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4.1-mini',
        voiceRu: id === 'elevenlabs' ? 'demoRuVoice' : '',
        voiceEn: id === 'elevenlabs' ? 'demoEnVoice' : '',
        inputRate: id === 'elevenlabs' ? null : id === 'neuroapi' ? 100000 : 400000,
        outputRate: id === 'elevenlabs' ? null : id === 'neuroapi' ? 400000 : 1600000,
        characterRate: id === 'elevenlabs' ? 100000 : null,
        confirmPricing: true,
        apiKey: key,
      },
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.body).not.toContain(key);
    config = providerSettingsSchema.parse(update.json().data);
    const row = (
      await f.db.query<{ credential_ciphertext: string }>(
        'SELECT credential_ciphertext FROM external_providers WHERE id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.credential_ciphertext).not.toContain(key);
    expect(f.crypto.decrypt(row.credential_ciphertext)).toBe(key);
  }
  return controls(root, {
    ...aiControlsSchema.parse({
      enabled: true,
      listeningEnabled: Boolean(options.speech),
      withListening: Boolean(options.withListening),
      strategy: 'cheapest',
      dailyMicros: 10_000_000,
      monthlyMicros: 10_000_000,
      perUserDailyMicros: 10_000_000,
      requestsPerUserDay: 20,
      maxTtsCharacters: 2000,
      maxOutputTokens: 1024,
      maxConcurrent: 2,
    }),
  });
}
async function correction(s: Login) {
  const p = await f.preparedPlan(s);
  await f.finish(s, (await f.start(s, p.plan.id, p.assignments[0]!.id)).run.id, [false, false]);
  return {
    planId: p.plan.id,
    assignment: (await f.plan(s, p.plan.id)).assignments.find((a) => a.kind === 'correction')!,
  };
}
async function listening(s: Login) {
  const bank = structuredClone(f.demo);
  bank.package.version = 2;
  const exercise = bank.exercises.find((e) => e.id === 'rki-01-practice-choice')!;
  exercise.version = 2;
  exercise.listening = { text: 'Здравствуйте. Меня зовут Анна.' };
  await new ContentService(f.db).import(bank);
  return new LuchEngine(f.db).start(s.actor, {
    packageId: 'luch-demo',
    source: { type: 'lesson', id: 'rki-01', purpose: 'practice' },
    restart: false,
  });
}
describe('provider controls, finance and listening', () => {
  it('starts with disabled providers and zero spending, so bank adaptation works without paid calls', async () => {
    const root = await f.active('superadmin'),
      s = await f.active(),
      config = await read(root);
    expect(config.ceilings.lifetimeMicros).toBe(0);
    expect(config.controls.enabled).toBe(false);
    expect(config.providers.every((p) => !p.enabled && !p.keyConfigured)).toBe(true);
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(run.current!.generatedExerciseId).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it('chooses the cheaper configured provider, saves a separate variant and grades it through the same engine', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root, { neuro: true });
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://neuroapi.host/v1/chat/completions');
    expect(JSON.stringify(calls[0]!.body)).not.toContain(s.actor.user.email);
    expect((calls[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    expect(run.current!.generatedExerciseId).not.toBeNull();
    expect(JSON.stringify(run.current!.exercise)).not.toContain('correctOptionId');
    expect(run.current!.exercise.instruction).toBe(question.instruction);
    const answer = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/answer`,
      headers: s.headers,
      payload: {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer: { type: 'choice', optionId: 'b' },
      },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().data.attempt.evaluation.correct).toBe(true);
    expect(answer.json().data.attempt.generatedExerciseId).toBe(run.current!.generatedExerciseId);
    const original = (
      await f.db.query<{ definition: { instruction: string } }>(
        "SELECT definition FROM learning_exercises WHERE package_id='luch-demo' AND package_version=1 AND id=$1",
        [run.current!.exercise.id],
      )
    ).rows[0]!;
    expect(original.definition.instruction).not.toBe(question.instruction);
    expect(
      (
        await f.db.query<{ status: string; charged_micros: string; reserved_micros: string }>(
          'SELECT * FROM provider_requests',
        )
      ).rows[0],
    ).toMatchObject({ status: 'success' });
  });
  it('allows only one external request for simultaneous starts and repeated requests', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root);
    const c = await correction(s);
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    handler = async () => {
      started();
      await gate;
      return completion();
    };
    const first = f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${c.planId}/assignments/${c.assignment.id}/start`,
      headers: s.headers,
      payload: {},
    });
    await ready;
    const repeated = await f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${c.planId}/assignments/${c.assignment.id}/start`,
      headers: s.headers,
      payload: {},
    });
    expect(repeated.statusCode).toBe(409);
    release();
    const done = await first;
    expect(done.statusCode, done.body).toBe(200);
    const run = runViewSchema.parse(done.json().data);
    expect((await f.start(s, c.planId, c.assignment.id)).run.id).toBe(run.run.id);
    expect(calls).toHaveLength(1);
  });
  it('reserves cost before sending and blocks parallel spending beyond the current daily ceiling', async () => {
    const root = await f.active('superadmin'),
      a = await f.active(),
      b = await f.active();
    await configure(root);
    const firstAssignment = await correction(a),
      secondAssignment = await correction(b);
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    handler = async () => {
      started();
      await gate;
      return completion();
    };
    const first = f.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${firstAssignment.planId}/assignments/${firstAssignment.assignment.id}/start`,
      headers: a.headers,
      payload: {},
    });
    await ready;
    const reserved = Number(
      (
        await f.db.query<{ reserved_micros: string }>(
          'SELECT reserved_micros FROM provider_requests',
        )
      ).rows[0]!.reserved_micros,
    );
    expect((await read(root)).spend.dailyMicros).toBe(reserved);
    await controls(root, { dailyMicros: reserved });
    const second = await f.start(b, secondAssignment.planId, secondAssignment.assignment.id);
    expect(second.current!.generatedExerciseId).toBeNull();
    expect(calls).toHaveLength(1);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await read(root)).spend.dailyMicros).toBeLessThanOrEqual(reserved);
  });
  it('enforces per-user call limits and rejects an expired quote without issuing a paid call', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root);
    await controls(root, { requestsPerUserDay: 1 });
    const c = await correction(s);
    let run = await f.start(s, c.planId, c.assignment.id);
    const answered = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/answer`,
      headers: s.headers,
      payload: {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer: { type: 'choice', optionId: 'a' },
      },
    });
    expect(answered.statusCode).toBe(200);
    run = runViewSchema.parse(answered.json().data.view);
    await f.next(s, run);
    const next = (await f.plan(s, c.planId)).assignments.find(
      (a) => a.kind === 'correction' && a.status === 'pending',
    )!;
    expect((await f.start(s, c.planId, next.id)).current!.generatedExerciseId).toBeNull();
    expect(calls).toHaveLength(1);
    const another = await f.active(),
      other = await correction(another),
      settings = new ProviderSettingsService(
        f.db,
        f.crypto,
        f.settings,
        () => Date.now() + 25 * 3_600_000,
      ),
      generation = new GenerationService(settings, new TextGenerationAdapter(fakeFetch));
    await generation.prepare(another.actor, other.planId, other.assignment.id);
    expect(calls).toHaveLength(1);
  });
  it('falls back to the bank after an ambiguous failure and never refunds or repeats an uncertain paid request', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root);
    handler = async () => {
      throw new Error('network failure');
    };
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(run.current!.generatedExerciseId).toBeNull();
    const row = (
      await f.db.query<{ status: string; charged_micros: string; reserved_micros: string }>(
        'SELECT * FROM provider_requests',
      )
    ).rows[0]!;
    expect(row.status).toBe('unknown');
    expect(row.charged_micros).toBe(row.reserved_micros);
    await f.start(s, c.planId, c.assignment.id);
    expect(calls).toHaveLength(1);
    expect(run.attempts).toHaveLength(0);
  });
  it('rejects invalid generated answer structures while preserving the usable original assignment', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root);
    handler = async () => completion({ ...question, correctOptionId: 'missing' });
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(run.current!.generatedExerciseId).toBeNull();
    expect((await f.db.query('SELECT * FROM generated_exercises')).rows).toHaveLength(0);
    expect((await f.db.query('SELECT * FROM provider_requests')).rows).toHaveLength(1);
  });
  it('disables paid services if reported usage exceeds the reservation', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root);
    handler = async () => completion(question, 99000, 100);
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(run.current!.generatedExerciseId).toBeNull();
    expect((await read(root)).controls.enabled).toBe(false);
    expect(
      (await f.db.query<{ status: string }>('SELECT status FROM provider_requests')).rows[0]!
        .status,
    ).toBe('overrun');
  });
  it('restricts administrators to controls within root ceilings, while protecting secrets, account data and CSRF', async () => {
    const root = await f.active('superadmin'),
      admin = await f.active('admin'),
      s = await f.active(),
      teacher = await f.active('teacher');
    await configure(root);
    expect((await read(admin)).canManageSecrets).toBe(false);
    await controls(admin, { maxOutputTokens: 512 });
    let current = await read(admin);
    const oversized = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/controls',
      headers: admin.headers,
      payload: {
        revision: current.revision,
        controls: { ...current.controls, dailyMicros: 20_000_000 },
      },
    });
    expect(oversized.statusCode).toBe(400);
    for (const url of ['/api/v1/admin/providers/ceilings', '/api/v1/admin/providers/openai'])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: admin.headers,
            payload: url.endsWith('ceilings')
              ? { revision: current.revision, ceilings: current.ceilings }
              : updateProviderSchema.parse({
                  revision: 1,
                  enabled: false,
                  model: 'gpt-4.1-mini',
                  inputRate: null,
                  outputRate: null,
                  characterRate: null,
                  confirmPricing: false,
                }),
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (await f.app.inject({ url: '/api/v1/admin/accounts', headers: admin.headers })).statusCode,
    ).toBe(403);
    for (const user of [s, teacher])
      expect(
        (await f.app.inject({ url: '/api/v1/admin/providers', headers: user.headers })).statusCode,
      ).toBe(403);
    expect((await f.app.inject({ url: '/api/v1/admin/providers' })).statusCode).toBe(401);
    current = await read(root);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/admin/providers/controls',
          headers: { cookie: root.headers.cookie },
          payload: { revision: current.revision, controls: current.controls },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('deduplicates/stops stale settings updates and clamps controls when root lowers ceilings', async () => {
    const root = await f.active('superadmin');
    await configure(root);
    let current = await read(root);
    const replies = await Promise.all(
      [512, 768].map((maxOutputTokens) =>
        f.app.inject({
          method: 'POST',
          url: '/api/v1/admin/providers/controls',
          headers: root.headers,
          payload: {
            revision: current.revision,
            controls: { ...current.controls, maxOutputTokens },
          },
        }),
      ),
    );
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    current = await read(root);
    const lowered = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/ceilings',
      headers: root.headers,
      payload: {
        revision: current.revision,
        ceilings: { ...current.ceilings, dailyMicros: 100, maxOutputTokens: 128 },
      },
    });
    expect(lowered.statusCode).toBe(200);
    expect(lowered.json().data.controls).toMatchObject({ dailyMicros: 100, maxOutputTokens: 128 });
  });
  it('creates listening variants only with a configured ElevenLabs connection and keeps transcripts private', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root, { speech: true, withListening: true });
    handler = async () =>
      completion({
        ...question,
        listeningText: 'Здравствуйте. Меня зовут Анна.',
        material: 'Здравствуйте. Меня зовут Анна.',
      });
    const c = await correction(s),
      run = await f.start(s, c.planId, c.assignment.id);
    expect(run.current!.exercise.hasListening).toBe(true);
    expect(JSON.stringify(run.current!.exercise)).not.toContain('Меня зовут Анна');
    expect(run.current!.exercise.blocks).toEqual([]);
  });
  it('uses ElevenLabs for listening, caches audio across requests and protects the binary endpoint', async () => {
    const root = await f.active('superadmin'),
      s = await f.active(),
      other = await f.active();
    await configure(root, { speech: true });
    handler = async () =>
      new Response(Buffer.from('ID3-demo-test-audio'), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    const run = await listening(s),
      stepId = run.current!.stepId;
    const prepare = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/engine/runs/${run.run.id}/steps/${stepId}/listening`,
        headers: s.headers,
        payload: { operationId: randomUUID() },
      });
    const first = await prepare();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.cached).toBe(false);
    const url = first.json().data.url as string;
    expect(calls[0]!.url).toContain('https://api.elevenlabs.io/v1/text-to-speech/demoRuVoice');
    expect(calls[0]!.body.text).toBe('Здравствуйте. Меня зовут Анна.');
    expect(calls[0]!.headers.has('xi-api-key')).toBe(true);
    expect((await prepare()).json().data.cached).toBe(true);
    await controls(root, { listeningEnabled: false });
    expect((await prepare()).json().data.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await f.app.inject({ url, headers: s.headers })).rawPayload.toString()).toBe(
      'ID3-demo-test-audio',
    );
    expect((await f.app.inject({ url, headers: other.headers })).statusCode).toBe(404);
    const ranged = await f.app.inject({ url, headers: { ...s.headers, range: 'bytes=0-2' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.toString()).toBe('ID3');
    expect(
      (await f.app.inject({ url, headers: { ...s.headers, range: 'bytes=99999-' } })).statusCode,
    ).toBe(416);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/engine/runs/${run.run.id}/steps/${stepId}/listening`,
          method: 'POST',
          headers: { cookie: s.headers.cookie },
          payload: { operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('never grades a speech failure and permits an explicit bounded retry with a new operation', async () => {
    const root = await f.active('superadmin'),
      s = await f.active();
    await configure(root, { speech: true });
    handler = async () => {
      throw new Error('speech failure');
    };
    const run = await listening(s),
      url = `/api/v1/engine/runs/${run.run.id}/steps/${run.current!.stepId}/listening`,
      operationId = randomUUID();
    const request = () =>
      f.app.inject({ method: 'POST', url, headers: s.headers, payload: { operationId } });
    expect((await request()).statusCode).toBe(503);
    expect((await request()).statusCode).toBe(503);
    expect(calls).toHaveLength(1);
    expect((await f.view(s, run.run.id)).attempts).toHaveLength(0);
    expect((await f.db.query('SELECT * FROM skill_observations')).rows).toHaveLength(0);
    handler = async () =>
      new Response(Buffer.from('ID3-demo'), { headers: { 'content-type': 'audio/mpeg' } });
    const retry = await f.app.inject({
      method: 'POST',
      url,
      headers: s.headers,
      payload: { operationId: randomUUID() },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(calls).toHaveLength(2);
  });
  it('requires price confirmation for new keys/voices and lets root remove secrets without returning them', async () => {
    const root = await f.active('superadmin');
    let current = await configure(root, { speech: true });
    const provider = current.providers.find((p) => p.id === 'openai')!,
      key = randomBytes(20).toString('hex');
    const payload = updateProviderSchema.parse({
      revision: provider.revision,
      enabled: true,
      model: provider.model,
      inputRate: provider.inputRate,
      outputRate: provider.outputRate,
      characterRate: null,
      confirmPricing: false,
      apiKey: key,
    });
    const rejected = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/openai',
      headers: root.headers,
      payload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('PROVIDER_INCOMPLETE');
    const voice = current.providers.find((p) => p.id === 'elevenlabs')!;
    const changedVoice = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/elevenlabs',
      headers: root.headers,
      payload: {
        revision: voice.revision,
        enabled: true,
        model: voice.model,
        voiceRu: 'anotherVoice',
        voiceEn: voice.voiceEn,
        inputRate: null,
        outputRate: null,
        characterRate: voice.characterRate,
        confirmPricing: false,
      },
    });
    expect(changedVoice.statusCode).toBe(400);
    const change = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/openai',
      headers: root.headers,
      payload: { ...payload, confirmPricing: true },
    });
    expect(change.statusCode, change.body).toBe(200);
    expect(change.body).not.toContain(key);
    current = providerSettingsSchema.parse(change.json().data);
    const remove = await f.app.inject({
      method: 'POST',
      url: '/api/v1/admin/providers/openai',
      headers: root.headers,
      payload: {
        revision: current.providers.find((p) => p.id === 'openai')!.revision,
        enabled: false,
        model: provider.model,
        inputRate: provider.inputRate,
        outputRate: provider.outputRate,
        characterRate: null,
        confirmPricing: false,
        clearKey: true,
      },
    });
    expect(remove.statusCode, remove.body).toBe(200);
    expect(
      remove.json().data.providers.find((p: { id: string }) => p.id === 'openai').keyConfigured,
    ).toBe(false);
  });
});
