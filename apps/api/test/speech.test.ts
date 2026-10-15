import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import {
  aiControlsSchema,
  aiCeilingsSchema,
  speechInputSchema,
  speechConfirmationSchema,
  speechSessionSchema,
  assistantChatSchema,
  providerSettingsSchema,
  type RunView,
} from '@luch/contracts';
import { learningFixture, failOn, type Login } from './helpers/learning.js';
import { ProviderSettingsService } from '../src/modules/providers/settings.js';
import { VoiceService } from '../src/modules/speech/service.js';
import { ElevenLabsTranscriptionAdapter } from '../src/modules/speech/adapter.js';
import { validateWav } from '../src/modules/speech/wav.js';
import { expireSpeechAudio } from '../src/modules/speech/repository.js';
import { AssistantAudioService } from '../src/modules/speech/audio.js';
let f: Awaited<ReturnType<typeof learningFixture>>,
  sttCalls = 0,
  ttsCalls = 0,
  transcript = 'Меня зовут Анна.',
  failStt = false,
  failTts = false,
  seenForm: FormData | undefined;
export function wav(seconds = 1) {
  const audio = Buffer.alloc(44 + Math.floor(seconds * 16000) * 2);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  for (let at = 44; at < audio.length; at += 2)
    audio.writeInt16LE(Math.round(Math.sin(at / 20) * 12000), at);
  return audio;
}
beforeAll(async () => {
  f = await learningFixture(async (url, options) => {
    if (String(url) === 'https://api.elevenlabs.io/v1/speech-to-text') {
      sttCalls++;
      seenForm = options!.body as FormData;
      if (failStt) throw new Error('network timeout');
      return Response.json({ text: transcript, language_code: 'ru' });
    }
    if (String(url).startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) {
      ttsCalls++;
      if (failTts) throw new Error('audio outage');
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    throw new Error('Unexpected provider URL');
  });
});
beforeEach(async () => {
  await f.reset();
  sttCalls = ttsCalls = 0;
  transcript = 'Меня зовут Анна.';
  failStt = failTts = false;
  seenForm = undefined;
});
afterAll(async () => {
  await f.app.close();
});
async function configured() {
  const root = await f.active('superadmin'),
    service = new ProviderSettingsService(f.db, f.crypto, f.settings);
  let config = await service.read(root.actor);
  config = await service.updateCeilings(root.actor, {
    revision: config.revision,
    ceilings: aiCeilingsSchema.parse({
      lifetimeMicros: 10000000,
      dailyMicros: 10000000,
      monthlyMicros: 10000000,
      perUserDailyMicros: 10000000,
      requestsPerUserDay: 100,
      maxRecordingSeconds: 30,
      maxTtsCharacters: 3000,
    }),
  });
  await service.updateControls(root.actor, {
    revision: config.revision,
    controls: aiControlsSchema.parse({
      transcriptionEnabled: true,
      assistantSpeechEnabled: true,
      dailyMicros: 10000000,
      monthlyMicros: 10000000,
      perUserDailyMicros: 10000000,
      requestsPerUserDay: 100,
      maxRecordingSeconds: 30,
      maxTtsCharacters: 3000,
    }),
  });
  for (const id of ['elevenlabs_stt', 'elevenlabs'] as const) {
    const p = (await service.read(root.actor)).providers.find((p) => p.id === id)!;
    await service.updateProvider(root.actor, id, {
      revision: p.revision,
      enabled: true,
      model: id === 'elevenlabs_stt' ? 'scribe_v2' : 'eleven_multilingual_v2',
      voiceRu: id === 'elevenlabs' ? 'voice-ru' : '',
      voiceEn: id === 'elevenlabs' ? 'voice-en' : '',
      inputRate: null,
      outputRate: null,
      characterRate: id === 'elevenlabs' ? 100000 : null,
      minuteRate: id === 'elevenlabs_stt' ? 20000 : null,
      confirmPricing: true,
      apiKey: 'test-only-elevenlabs-key',
      clearKey: false,
    });
  }
  return { root, service };
}
async function run(s: Login, id = 'rki-01', purpose = 'practice') {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: s.headers,
    payload: { packageId: 'luch-demo', source: { type: 'lesson', id, purpose } },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data as RunView;
}
async function upload(s: Login, r: RunView, operationId = randomUUID(), audio = wav()) {
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
    headers: s.headers,
    payload: { turnId: r.current!.turn.id, operationId, audioBase64: audio.toString('base64') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return speechInputSchema.parse(response.json().data);
}
async function confirm(
  s: Login,
  r: RunView,
  id: string,
  text = transcript,
  optionId?: string,
  operationId = randomUUID(),
) {
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${id}/confirm`,
    headers: s.headers,
    payload: { operationId, text, ...(optionId ? { optionId } : {}) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return speechConfirmationSchema.parse(response.json().data);
}
async function rowCount(table: string) {
  return Number(
    (await f.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n,
  );
}

describe('ElevenLabs voice interaction', () => {
  it('validates real PCM frames, headers, silence and duration before any provider call', () => {
    expect(validateWav(wav().toString('base64')).durationMs).toBe(1000);
    expect(() => validateWav('invalid-base64')).toThrow();
    const wrong = wav();
    wrong.writeUInt32LE(48000, 24);
    expect(() => validateWav(wrong.toString('base64'))).toThrow();
    const silence = wav();
    silence.fill(0, 44);
    expect(() => validateWav(silence.toString('base64'))).toThrow();
    expect(() => validateWav(wav(30.1).toString('base64'))).toThrow();
    expect(() => validateWav(wav(0.05).toString('base64'))).toThrow();
    expect(sttCalls).toBe(0);
  });
  it.each(['ru', 'en'] as const)(
    'sends multipart WAV to Scribe for %s and persists ungraded recognition safely',
    async (language) => {
      await configured();
      const s = await f.active(),
        r = await run(s, language === 'ru' ? 'rki-01' : 'english-01'),
        operationId = randomUUID();
      transcript = language === 'ru' ? 'Меня зовут Анна.' : 'I am Anna.';
      const a = await upload(s, r, operationId),
        again = await upload(s, r, operationId);
      expect(a.status).toBe('ready');
      expect(a.id).toBe(again.id);
      expect(a.transcript).toBe(transcript);
      expect(sttCalls).toBe(1);
      expect(seenForm!.get('model_id')).toBe('scribe_v2');
      expect(seenForm!.get('language_code')).toBe(language);
      expect(seenForm!.get('file')).toBeInstanceOf(File);
      expect(seenForm!.get('tag_audio_events')).toBe('false');
      expect((await (seenForm!.get('file') as File).arrayBuffer()).byteLength).toBe(wav().length);
      expect((await f.view(s, r.run.id)).attempts).toHaveLength(0);
      const stored = (await f.db.query('SELECT * FROM speech_inputs WHERE id=$1', [a.id])).rows[0]!;
      expect(stored.audio).toBeNull();
      const session = await f.app.inject({
        url: `/api/v1/engine/runs/${r.run.id}/speech`,
        headers: s.headers,
      });
      expect(speechSessionSchema.parse(session.json().data).input?.id).toBe(a.id);
      const request = (await f.db.query('SELECT * FROM provider_requests')).rows[0]!;
      expect(request.kind).toBe('transcription');
      expect(Number(request.charged_micros)).toBe(20000);
    },
  );
  it('confirms into the existing evaluator, assistant, skill state and plan in one transaction without duplicates', async () => {
    await configured();
    const s = await f.active(),
      p = await f.preparedPlan(s),
      r = await f.start(s, p.plan.id, p.assignments[0]!.id),
      a = await upload(s, r),
      operationId = randomUUID();
    const wrong = f.answerFor(r, false);
    if (wrong.type !== 'choice') throw new Error('Choice expected');
    const text =
      r.current!.exercise.response.type === 'choice'
        ? r.current!.exercise.response.options.find((o) => o.id === wrong.optionId)!.text
        : 'wrong';
    const result = await confirm(s, r, a.id, text, wrong.optionId, operationId),
      again = await confirm(s, r, a.id, text, wrong.optionId, operationId);
    expect(result.input.status).toBe('confirmed');
    expect(result.input.edited).toBe(true);
    expect(result.input.attemptId).toBe(again.input.attemptId);
    const attempt = result.view.attempts.at(-1)!;
    expect(attempt.evaluation?.correct).toBe(false);
    expect(attempt.speechInputId).toBe(a.id);
    expect(attempt.independent).toBe(true);
    expect(attempt.assistantHelp).toBe(false);
    expect(result.assignment?.kind).toBe('correction');
    expect(result.input.reply).toContain('ошибка');
    expect(await rowCount('assistant_exchanges')).toBe(1);
    expect(await rowCount('speech_inputs')).toBe(1);
    expect(
      (await f.db.query('SELECT * FROM skill_observations WHERE attempt_id=$1', [attempt.id])).rows,
    ).toHaveLength(1);
    const chat = assistantChatSchema.parse(
      (
        await f.app.inject({
          url: `/api/v1/assistant/runs/${r.run.id}/messages`,
          headers: s.headers,
        })
      ).json().data,
    );
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]!.content).toBe(text);
    expect(chat.messages[1]!.content).toBe(result.input.reply);
    expect(chat.messages[1]!.action).toBe('answer');
  });
  it('uses exact choice matching and allows explicit mapping without guessing the answer or grading an ambiguous transcript', async () => {
    await configured();
    const s = await f.active(),
      r = await run(s),
      a = await upload(s, r);
    const good = f.answerFor(r, true);
    if (good.type !== 'choice') throw new Error('choice');
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}/confirm`,
      headers: s.headers,
      payload: { operationId: randomUUID(), text: 'первая реплика' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SPEECH_CHOICE_REQUIRED');
    expect((await f.view(s, r.run.id)).attempts).toHaveLength(0);
    const option =
      r.current!.exercise.response.type === 'choice'
        ? r.current!.exercise.response.options.find((o) => o.id === good.optionId)!.text
        : '';
    const result = await confirm(s, r, a.id, option.toLowerCase().replace(/[!.,]/g, ''));
    expect(result.view.attempts[0]!.evaluation!.correct).toBe(true);
  });
  it.each(['ru', 'en'] as const)(
    'evaluates confirmed %s short text using the pinned engine solution and preserves pre-answer help',
    async (language) => {
      await configured();
      const s = await f.active();
      let r = await run(s, language === 'ru' ? 'rki-01' : 'english-01');
      r = await f.next(s, await f.answer(s, r, true));
      const good = f.answerFor(r, true);
      if (good.type !== 'short_text') throw new Error('Short text expected');
      const help = await f.app.inject({
        method: 'POST',
        url: `/api/v1/assistant/runs/${r.run.id}/messages`,
        headers: s.headers,
        payload: {
          turnId: r.current!.turn.id,
          operationId: randomUUID(),
          action: 'hint',
          text: '',
        },
      });
      expect(help.statusCode, help.body).toBe(200);
      transcript = 'Unreliable recognition';
      const a = await upload(s, r),
        result = await confirm(s, r, a.id, good.text);
      const attempt = result.view.attempts.at(-1)!;
      expect(attempt.answer).toEqual(good);
      expect(attempt.evaluation!.correct).toBe(true);
      expect(attempt.assistantHelp).toBe(true);
      expect(attempt.independent).toBe(false);
      expect(result.input.transcript).toBe('Unreliable recognition');
      expect(result.input.confirmedText).toBe(good.text);
      expect(result.input.edited).toBe(true);
    },
  );
  it('retains superadmin assistance when the student confirms a recording uploaded on their behalf', async () => {
    const { root } = await configured();
    const s = await f.active(),
      r = await run(s),
      a = await upload(root, r),
      result = await confirm(s, r, a.id);
    expect(result.view.attempts[0]!.adminAssistance).toBe(true);
    expect(result.view.attempts[0]!.independent).toBe(false);
    const row = (await f.db.query('SELECT * FROM speech_inputs WHERE id=$1', [a.id])).rows[0]!;
    expect(row.actor_id).toBe(root.actor.user.id);
    expect(row.confirmed_by).toBe(s.actor.user.id);
  });
  it('serializes simultaneous confirmation deliveries into one attempt, exchange and plan change', async () => {
    await configured();
    const s = await f.active(),
      p = await f.preparedPlan(s),
      r = await f.start(s, p.plan.id, p.assignments[0]!.id),
      a = await upload(s, r),
      operationId = randomUUID();
    const wrong = f.answerFor(r, false);
    if (wrong.type !== 'choice') throw new Error('Choice expected');
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        confirm(s, r, a.id, 'Мой ответ', wrong.optionId, operationId),
      ),
    );
    expect(new Set(results.map((r) => r.input.attemptId)).size).toBe(1);
    expect(new Set(results.map((r) => r.assignment!.id)).size).toBe(1);
    expect(await rowCount('assistant_exchanges')).toBe(1);
    expect((await f.view(s, r.run.id)).attempts).toHaveLength(1);
  });
  it('treats a provider outage as a technical failure and supports safe retry and an independent text fallback', async () => {
    await configured();
    const s = await f.active(),
      p = await f.preparedPlan(s),
      r = await f.start(s, p.plan.id, p.assignments[0]!.id),
      operationId = randomUUID();
    failStt = true;
    const a = await upload(s, r, operationId);
    expect(a.status).toBe('error');
    expect(a.canRetry).toBe(true);
    await upload(s, r, operationId);
    expect(sttCalls).toBe(1);
    expect((await f.view(s, r.run.id)).attempts).toHaveLength(0);
    const retryId = randomUUID();
    failStt = false;
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}/retry`,
      headers: s.headers,
      payload: { operationId: retryId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const retry = speechInputSchema.parse(response.json().data);
    expect(retry.status).toBe('ready');
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}/retry`,
      headers: s.headers,
      payload: { operationId: retryId },
    });
    expect(response.json().data.id).toBe(retry.id);
    expect(sttCalls).toBe(2);
    const good = f.answerFor(r, true);
    if (good.type !== 'choice') throw new Error('Choice');
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/text`,
      headers: s.headers,
      payload: {
        turnId: r.current!.turn.id,
        operationId: randomUUID(),
        text: 'Мой ответ',
        optionId: good.optionId,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = speechConfirmationSchema.parse(response.json().data);
    expect(result.input.source).toBe('text');
    expect(result.view.attempts.at(-1)!.evaluation!.correct).toBe(true);
    expect(result.view.attempts.at(-1)!.independent).toBe(true);
    expect(
      (await f.db.query("SELECT * FROM provider_requests WHERE status='unknown'")).rows,
    ).toHaveLength(1);
  });
  it.each(['diagnostic', 'control'] as const)(
    'keeps %s grades and hints closed after a confirmed spoken answer',
    async (purpose) => {
      await configured();
      const s = await f.active(),
        r = await run(s, 'rki-01', purpose),
        a = await upload(s, r),
        result = await confirm(
          s,
          r,
          a.id,
          'мой ответ',
          r.current!.exercise.response.type === 'choice'
            ? r.current!.exercise.response.options[0]!.id
            : undefined,
        );
      expect(result.view.attempts[0]!.evaluation).toBeNull();
      expect(result.input.reply).toBe(
        'Ответ сохранён. Оценка и объяснение появятся после завершения всей проверки.',
      );
      expect(result.assignment).toBeNull();
      const chat = assistantChatSchema.parse(
        (
          await f.app.inject({
            url: `/api/v1/assistant/runs/${r.run.id}/messages`,
            headers: s.headers,
          })
        ).json().data,
      );
      expect(chat.hintsEnabled).toBe(false);
      expect(JSON.stringify(chat)).not.toContain('correctOptionIds');
    },
  );
  it('rejects stale confirmation, stale paid uploads and conflicting payloads without extra charges or attempts', async () => {
    await configured();
    const s = await f.active(),
      r = await run(s),
      op = randomUUID(),
      a = await upload(s, r, op);
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
      headers: s.headers,
      payload: {
        turnId: r.current!.turn.id,
        operationId: op,
        audioBase64: wav(2).toString('base64'),
      },
    });
    expect(response.statusCode).toBe(409);
    const answered = await f.answer(s, r, true);
    await f.next(s, answered);
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}/confirm`,
      headers: s.headers,
      payload: { operationId: randomUUID(), text: transcript },
    });
    expect(response.statusCode).toBe(409);
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
      headers: s.headers,
      payload: {
        turnId: r.current!.turn.id,
        operationId: randomUUID(),
        audioBase64: wav().toString('base64'),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(sttCalls).toBe(1);
  });
  it('rolls back the attempt, feedback and adaptation if saving speech confirmation fails', async () => {
    const { service } = await configured();
    const s = await f.active(),
      p = await f.preparedPlan(s),
      r = await f.start(s, p.plan.id, p.assignments[0]!.id),
      a = await upload(s, r),
      broken = new VoiceService(
        new ProviderSettingsService(
          failOn(f.db, "UPDATE speech_inputs SET status='confirmed'"),
          f.crypto,
          f.settings,
        ),
      );
    await expect(
      broken.confirm(s.actor, r.run.id, a.id, { operationId: randomUUID(), text: transcript }),
    ).rejects.toThrow();
    const saved = await f.view(s, r.run.id);
    expect(saved.current!.attempt).toBeNull();
    expect(
      (await f.db.query('SELECT status FROM speech_inputs WHERE id=$1', [a.id])).rows[0]!.status,
    ).toBe('ready');
    expect(await rowCount('assistant_exchanges')).toBe(0);
    expect((await f.plan(s, p.plan.id)).assignments).toHaveLength(6);
    expect((await service.read((await f.active('superadmin')).actor)).spend.pending).toBe(0);
  });
  it('caches authorized assistant speech and supports Range, disablement and technical replay without changing grades', async () => {
    const { root, service } = await configured();
    const s = await f.active(),
      r = await run(s),
      a = await upload(s, r),
      result = await confirm(s, r, a.id),
      message = result.input.messageId!;
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/messages/${message}/audio`,
      headers: s.headers,
      payload: { operationId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const url = response.json().data.url;
    response = await f.app.inject({ url, headers: { ...s.headers, range: 'bytes=1-2' } });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.length).toBe(2);
    const config = await service.read(root.actor);
    await service.updateControls(root.actor, {
      revision: config.revision,
      controls: { ...config.controls, assistantSpeechEnabled: false },
    });
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/messages/${message}/audio`,
      headers: s.headers,
      payload: { operationId: randomUUID() },
    });
    expect(response.json().data.cached).toBe(true);
    expect(ttsCalls).toBe(1);
    expect((await f.view(s, r.run.id)).attempts).toHaveLength(1);
    const peer = await f.active();
    expect((await f.app.inject({ url, headers: peer.headers })).statusCode).toBe(404);
  });
  it('keeps saved feedback and grade when TTS fails, and retries only on an explicit new operation', async () => {
    await configured();
    const s = await f.active(),
      r = await run(s),
      a = await upload(s, r),
      result = await confirm(s, r, a.id),
      id = result.input.messageId!,
      operationId = randomUUID();
    failTts = true;
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/messages/${id}/audio`,
      headers: s.headers,
      payload: { operationId },
    });
    expect(response.statusCode).toBe(503);
    failTts = false;
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/messages/${id}/audio`,
      headers: s.headers,
      payload: { operationId },
    });
    expect(response.statusCode).toBe(503);
    expect(ttsCalls).toBe(1);
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/messages/${id}/audio`,
      headers: s.headers,
      payload: { operationId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(ttsCalls).toBe(2);
    expect((await f.view(s, r.run.id)).attempts[0]!.evaluation!.correct).toBe(true);
  });
  it('enforces ownership, assigned teacher read-only access and CSRF for microphone operations', async () => {
    await configured();
    const s = await f.active(),
      peer = await f.active(),
      teacher = await f.active('teacher'),
      r = await run(s),
      a = await upload(s, r);
    expect((await f.app.inject({ url: `/api/v1/engine/runs/${r.run.id}/speech` })).statusCode).toBe(
      401,
    );
    expect(
      (
        await f.app.inject({
          url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}`,
          headers: peer.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
          headers: { cookie: s.headers.cookie },
          payload: {
            turnId: r.current!.turn.id,
            operationId: randomUUID(),
            audioBase64: wav().toString('base64'),
          },
        })
      ).statusCode,
    ).toBe(403);
    await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      s.actor.user.id,
    ]);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}`,
          headers: teacher.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/v1/engine/runs/${r.run.id}/speech/inputs/${a.id}/confirm`,
          headers: teacher.headers,
          payload: { operationId: randomUUID(), text: transcript },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('recovers interrupted recognition without a paid redispatch and deletes expired retry audio', async () => {
    const { service } = await configured();
    const s = await f.active(),
      r = await run(s);
    failStt = true;
    const a = await upload(s, r);
    await f.db.query(
      "UPDATE speech_inputs SET status='processing',updated_at=$2,audio_expires_at=$2 WHERE id=$1",
      [a.id, new Date(Date.now() - 60000)],
    );
    const voice = new VoiceService(service);
    const session = await voice.session(s.actor, r.run.id);
    expect(session.input!.status).toBe('error');
    expect(sttCalls).toBe(1);
    await expireSpeechAudio(f.db, Date.now());
    expect(
      (await f.db.query('SELECT audio FROM speech_inputs WHERE id=$1', [a.id])).rows[0]!.audio,
    ).toBeNull();
    expect((await voice.read(s.actor, r.run.id, a.id)).canRetry).toBe(false);
  });
  it('reserves no paid work with disabled budgets or expired prices and restricts settings to the right role', async () => {
    const s = await f.active(),
      r = await run(s);
    const session = await f.app.inject({
      url: `/api/v1/engine/runs/${r.run.id}/speech`,
      headers: s.headers,
    });
    expect(speechSessionSchema.parse(session.json().data).enabled).toBe(false);
    let response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
      headers: s.headers,
      payload: {
        turnId: r.current!.turn.id,
        operationId: randomUUID(),
        audioBase64: wav().toString('base64'),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(sttCalls).toBe(0);
    expect(await rowCount('provider_requests')).toBe(0);
    const { root, service } = await configured();
    await f.db.query(
      "UPDATE external_providers SET pricing_confirmed_at=$1 WHERE id='elevenlabs_stt'",
      [new Date(Date.now() - 8 * 86400000)],
    );
    response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${r.run.id}/speech/inputs`,
      headers: s.headers,
      payload: {
        turnId: r.current!.turn.id,
        operationId: randomUUID(),
        audioBase64: wav().toString('base64'),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(sttCalls).toBe(0);
    expect(
      providerSettingsSchema
        .parse(
          (await f.app.inject({ url: '/api/v1/admin/providers', headers: root.headers })).json()
            .data,
        )
        .providers.find((p) => p.id === 'elevenlabs_stt')!.model,
    ).toBe('scribe_v2');
    await expect(service.read(s.actor)).rejects.toMatchObject({ statusCode: 403 });
  });
});
