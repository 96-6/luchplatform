import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  catalogSchema,
  contentPackageSchema,
  lessonViewSchema,
  routeViewSchema,
  setViewSchema,
  type ContentPackage,
  type User,
} from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings, projectRoot } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrations.js';
import { AccountCrypto, createTotp } from '../src/modules/auth/crypto.js';
import { seedDemoContent } from '../src/modules/content/bootstrap.js';
import { ContentService, canonicalJson } from '../src/modules/content/service.js';

const settings = parseSettings({
  APP_ENV: 'test',
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
  LOG_LEVEL: 'silent',
});
if (
  process.env.TEST_DATABASE_URL &&
  !new URL(process.env.TEST_DATABASE_URL).pathname.includes('test')
)
  throw new Error('Use an isolated test database.');
const crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let service: ContentService;
let demo: ContentPackage;
beforeAll(async () => {
  demo = contentPackageSchema.parse(
    JSON.parse(await readFile(resolve(projectRoot, 'content/demo/luch-demo.json'), 'utf8')),
  );
  db = await createDatabase(settings);
  await migrate(db);
  service = new ContentService(db);
  app = await buildApp(settings, db);
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE content_packages CASCADE; UPDATE security_policy SET captcha_enabled=false,vpn_check_enabled=false; DELETE FROM users WHERE email LIKE 'content-test-%'",
  );
});
afterAll(async () => {
  await db.exec(
    "DELETE FROM users WHERE email LIKE 'content-test-%'; UPDATE security_policy SET captcha_enabled=true,vpn_check_enabled=false",
  );
  await app.close();
});
const copy = () => structuredClone(demo);
async function login(role: User['role'] = 'student') {
  const id = randomUUID(),
    email = `content-test-${id}@example.test`,
    secret = createTotp(email).secret.base32;
  await db.query(
    'INSERT INTO users (id,email,full_name,role,email_verified_at,totp_enabled_at,totp_secret_ciphertext,access_verified) VALUES ($1,$2,$3,$4,now(),now(),$5,true)',
    [id, email, 'Content test', role, crypto.encrypt(secret)],
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, code: createTotp(email, secret).generate() },
  });
  expect(response.statusCode).toBe(200);
  const session = response.cookies.find((cookie) => cookie.name === 'luch_session')!;
  return {
    cookie: `luch_session=${session.value}`,
    'x-csrf-token': response.json().data.csrfToken as string,
  };
}
async function count(table: string) {
  return Number(
    (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]!
      .count,
  );
}

describe('learning content acceptance', () => {
  it('starts with an authenticated empty catalog and keeps administration private', async () => {
    expect((await app.inject({ url: '/api/v1/content/routes' })).statusCode).toBe(401);
    const headers = await login();
    const empty = await app.inject({ url: '/api/v1/content/routes', headers });
    expect(catalogSchema.parse(empty.json().data)).toEqual([]);
    for (const actor of [headers, await login('teacher')]) {
      for (const url of [
        '/api/v1/admin/content/packages',
        '/api/v1/admin/content/packages/luch-demo/export',
      ])
        expect((await app.inject({ url, headers: actor })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/content/import',
            headers: actor,
            payload: demo,
          })
        ).statusCode,
      ).toBe(403);
    }
  });
  it('seeds both routes, twelve lessons, skills and separate banks without duplicates', async () => {
    expect((await seedDemoContent(db)).status).toBe('imported');
    expect((await seedDemoContent(db)).status).toBe('unchanged');
    for (const [table, expected] of [
      ['content_packages', 1],
      ['content_revisions', 1],
      ['learning_routes', 2],
      ['learning_lessons', 12],
      ['learning_skills', 12],
      ['learning_exercises', 48],
      ['learning_sets', 6],
      ['learning_set_exercises', 48],
      ['learning_assets', 4],
    ] as const)
      expect(await count(table)).toBe(expected);
    const headers = await login();
    const catalog = catalogSchema.parse(
      (await app.inject({ url: '/api/v1/content/routes', headers })).json().data,
    );
    expect(catalog.map((route) => [route.language, route.lessonCount])).toEqual([
      ['ru', 6],
      ['en', 6],
    ]);
    for (const route of catalog) {
      const view = routeViewSchema.parse(
        (
          await app.inject({
            url: `/api/v1/content/packages/luch-demo/routes/${route.id}`,
            headers,
          })
        ).json().data,
      );
      expect(view.lessons.map((lesson) => lesson.id)).toEqual(
        demo.routes.find((item) => item.id === route.id)!.lessonIds,
      );
      for (const lesson of view.lessons) {
        for (const [purpose, expected] of [
          ['practice', 2],
          ['diagnostic', 1],
          ['control', 1],
        ] as const) {
          const response = await app.inject({
            url: `/api/v1/content/packages/luch-demo/lessons/${lesson.id}?purpose=${purpose}`,
            headers,
          });
          expect(response.statusCode).toBe(200);
          const material = lessonViewSchema.parse(response.json().data);
          expect(material.exercises).toHaveLength(expected);
          expect(material.exercises.every((exercise) => exercise.purpose === purpose)).toBe(true);
          expect(response.body).not.toMatch(/"(?:solution|explanation|hints|rubric|review)":/);
        }
      }
      const setIds: string[][] = [];
      for (const set of view.sets) {
        const response = await app.inject({
          url: `/api/v1/content/packages/luch-demo/sets/${set.id}`,
          headers,
        });
        const bank = setViewSchema.parse(response.json().data);
        expect(bank.exercises.map((exercise) => exercise.id)).toEqual(bank.exerciseIds);
        expect(response.body).not.toMatch(/"(?:solution|explanation|hints|rubric|review)":/);
        setIds.push(bank.exerciseIds);
      }
      expect(new Set(setIds.flat()).size).toBe(setIds.flat().length);
    }
  });
  it('exports and reimports the complete format including solution metadata and media', async () => {
    const headers = await login('superadmin');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/content/import',
          headers: { cookie: headers.cookie },
          payload: demo,
        })
      ).statusCode,
    ).toBe(403);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/content/import',
      headers,
      payload: demo,
    });
    expect(imported.statusCode).toBe(200);
    const exported = await app.inject({
      url: '/api/v1/admin/content/packages/luch-demo/export',
      headers,
    });
    const data = contentPackageSchema.parse(exported.json().data);
    expect(canonicalJson(data)).toBe(canonicalJson(demo));
    const reordered = Object.fromEntries(Object.entries(data).reverse());
    expect((await service.import(JSON.parse(JSON.stringify(reordered)))).status).toBe('unchanged');
    data.package.id = 'round-trip';
    expect((await service.import(data)).status).toBe('imported');
    expect(await service.export('round-trip')).toEqual(data);
    expect(
      (await db.query('SELECT id FROM security_audit WHERE action=$1', ['content.imported'])).rows
        .length,
    ).toBeGreaterThan(0);
  });
  it('round-trips literal answer variants without applying future evaluation rules', async () => {
    const literal = copy();
    const solution = literal.exercises.find(
      (exercise) => exercise.response.type === 'short_text',
    )!.solution;
    if (solution.type !== 'short_text') throw new Error('Short-text fixture required.');
    solution.accepted = ['  is  ', 'IS'];
    solution.normalization.trim = false;
    solution.normalization.collapseWhitespace = false;
    solution.normalization.caseSensitive = true;
    literal.assets[0]!.sha256 = undefined;
    await service.import(literal);
    const exported = await service.export('luch-demo');
    expect(
      exported.exercises.find((exercise) => exercise.response.type === 'short_text')!.solution,
    ).toEqual(solution);
    expect((await service.import(JSON.parse(JSON.stringify(exported)))).status).toBe('unchanged');
  });
  it('preserves revisions and never rolls back a newer package through demo seeding', async () => {
    await service.import(demo);
    const edited = copy();
    edited.exercises[0]!.instruction = 'Новое задание для проверки версии.';
    await expect(service.import(edited)).rejects.toMatchObject({
      code: 'CONTENT_VERSION_CONFLICT',
    });
    edited.package.version = 2;
    await expect(service.import(edited)).rejects.toMatchObject({
      code: 'EXERCISE_VERSION_CONFLICT',
    });
    edited.exercises[0]!.version = 2;
    expect((await service.import(edited)).status).toBe('imported');
    expect(await service.export('luch-demo', 1)).toEqual(demo);
    expect(await service.export('luch-demo')).toEqual(edited);
    expect(await seedDemoContent(db)).toMatchObject({ status: 'unchanged', currentVersion: 2 });
    const headers = await login();
    expect(
      lessonViewSchema.parse(
        (
          await app.inject({
            url: '/api/v1/content/packages/luch-demo/lessons/rki-01?purpose=diagnostic&packageVersion=1',
            headers,
          })
        ).json().data,
      ).exercises[0]!.instruction,
    ).toBe(demo.exercises[0]!.instruction);
    expect(
      lessonViewSchema.parse(
        (
          await app.inject({
            url: '/api/v1/content/packages/luch-demo/lessons/rki-01?purpose=diagnostic',
            headers,
          })
        ).json().data,
      ).exercises[0]!.instruction,
    ).toBe(edited.exercises[0]!.instruction);
    const criteria = structuredClone(edited);
    criteria.package.version = 3;
    criteria.exercises[0]!.version = 3;
    criteria.exercises[0]!.rubric.criteria = ['Изменённое условие оценки.'];
    await expect(service.import(criteria)).rejects.toMatchObject({
      code: 'RUBRIC_VERSION_CONFLICT',
    });
    expect(await count('content_revisions')).toBe(2);
  });
  it('checks versions of removed and reintroduced exercises against history', async () => {
    await service.import(demo);
    const without = copy();
    without.package.version = 2;
    const removed = without.exercises.shift()!;
    without.sets.forEach((set) => {
      set.exerciseIds = set.exerciseIds.filter((id) => id !== removed.id);
    });
    await service.import(without);
    const reintroduced = copy();
    reintroduced.package.version = 3;
    reintroduced.exercises[0]!.instruction = 'Изменённая инструкция старого задания.';
    await expect(service.import(reintroduced)).rejects.toMatchObject({
      code: 'EXERCISE_VERSION_CONFLICT',
    });
    expect(await count('content_revisions')).toBe(2);
  });
  it('serializes concurrent imports into one revision', async () => {
    const results = await Promise.all([
      service.import(demo),
      service.import(demo),
      service.import(demo),
    ]);
    expect(results.filter((result) => result.status === 'imported')).toHaveLength(1);
    expect(await count('learning_exercises')).toBe(48);
    expect(await count('content_revisions')).toBe(1);
  });
  it.each([
    [
      'missing skill',
      (data: ContentPackage) => {
        data.exercises[0]!.skillId = 'missing';
      },
    ],
    [
      'wrong route',
      (data: ContentPackage) => {
        data.lessons[0]!.routeId = 'english-a1';
      },
    ],
    [
      'overlapping banks',
      (data: ContentPackage) => {
        data.sets[1]!.exerciseIds.push(data.sets[0]!.exerciseIds[0]!);
      },
    ],
    [
      'incorrect answer key',
      (data: ContentPackage) => {
        const solution = data.exercises[0]!.solution;
        if (solution.type === 'choice') solution.correctOptionIds = ['missing'];
      },
    ],
    [
      'control hints',
      (data: ContentPackage) => {
        data.exercises.find((exercise) => exercise.purpose === 'control')!.hints = ['Hint'];
      },
    ],
    [
      'unsafe media URL',
      (data: ContentPackage) => {
        data.assets[0]!.src = 'javascript:alert(1)';
      },
    ],
    [
      'missing editorial approval',
      (data: ContentPackage) => {
        data.package.isDemo = false;
      },
    ],
    [
      'duplicate lesson',
      (data: ContentPackage) => {
        data.lessons.push(data.lessons[0]!);
      },
    ],
  ])('rejects %s before changing the database', async (_name, modify) => {
    const invalid = copy();
    modify(invalid);
    await expect(service.import(invalid)).rejects.toBeInstanceOf(ZodError);
    expect(await count('content_packages')).toBe(0);
  });
  it('rolls back all content if persistence fails halfway through an import', async () => {
    const failing: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: (sql, params) => {
              if (sql.startsWith('INSERT INTO learning_exercises'))
                throw new Error('Simulated storage failure');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(new ContentService(failing).import(demo)).rejects.toThrow(
      'Simulated storage failure',
    );
    expect(await count('content_packages')).toBe(0);
    expect(await count('learning_lessons')).toBe(0);
    expect(await count('content_revisions')).toBe(0);
  });
  it('checks local assets and supports audio/video references without fetching them', async () => {
    const missing = copy();
    missing.assets[0]!.src = '/learning-media/missing.svg';
    await expect(service.import(missing)).rejects.toMatchObject({ code: 'CONTENT_ASSET_MISSING' });
    const changed = copy();
    changed.assets[0]!.sha256 = '0'.repeat(64);
    await expect(service.import(changed)).rejects.toMatchObject({ code: 'CONTENT_ASSET_CHANGED' });
    const rich = copy();
    for (const kind of ['audio', 'video'] as const) {
      rich.assets.push({
        id: `sample-${kind}`,
        kind,
        src: `https://example.test/${kind}`,
        mediaType: kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
        author: 'Demo',
        license: 'CC0-1.0',
      });
      rich.lessons[0]!.blocks.push({
        id: kind,
        type: kind,
        assetId: `sample-${kind}`,
        transcript: 'Hello! My name is Anna.',
      });
    }
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No external fetch expected'));
    try {
      await service.import(rich);
      expect(await service.export('luch-demo')).toEqual(rich);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it('returns validation and missing-content errors through the existing API contract', async () => {
    await service.import(demo);
    const headers = await login();
    for (const suffix of [
      '/lessons/missing',
      '/routes/missing',
      '/sets/missing',
      '/lessons/rki-01?packageVersion=999',
    ])
      expect(
        (await app.inject({ url: `/api/v1/content/packages/luch-demo${suffix}`, headers }))
          .statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          url: '/api/v1/content/packages/luch-demo/lessons/rki-01?purpose=invalid',
          headers,
        })
      ).json().error.code,
    ).toBe('VALIDATION_ERROR');
    const admin = await login('superadmin');
    const invalid = copy();
    invalid.exercises[0]!.skillId = 'missing';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/content/import',
      headers: admin,
      payload: invalid,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.fields).toHaveProperty('exercises.0.skillId');
  });
});

it('keeps the imported catalog and exact export after reopening a disk database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luch-content-'));
  let first: Database | undefined, second: Database | undefined;
  try {
    first = await createDatabase({ DATABASE_URL: `pglite:${directory}/db`, DATABASE_SSL: false });
    await migrate(first);
    await new ContentService(first).import(demo);
    await first.close();
    first = undefined;
    second = await createDatabase({ DATABASE_URL: `pglite:${directory}/db`, DATABASE_SSL: false });
    const reopened = new ContentService(second);
    expect(await reopened.export('luch-demo')).toEqual(demo);
    expect((await reopened.repository.catalog()).map((route) => route.lessonCount)).toEqual([6, 6]);
  } finally {
    await first?.close();
    await second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
