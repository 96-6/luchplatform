import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  CONTENT_MAX_BYTES,
  contentPackageSchema,
  exerciseSchema,
  type ContentPackage,
  type Exercise,
} from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { projectRoot } from '../../config.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import { ContentRepository } from './repository.js';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const checksum = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function parseContent(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > CONTENT_MAX_BYTES)
    throw new AppError(413, 'CONTENT_TOO_LARGE', 'Пакет контента превышает 2 МиБ.');
  return contentPackageSchema.parse(value);
}
export async function validateContentAssets(manifest: ContentPackage) {
  for (const asset of manifest.assets) {
    // Remote media are references only: imports never fetch third-party URLs.
    if (!asset.src.startsWith('/learning-media/')) continue;
    let bytes: Buffer | undefined;
    for (const folder of ['apps/web/public', 'apps/web/dist']) {
      const root = resolve(projectRoot, folder);
      try {
        const actual = await realpath(resolve(root, `.${asset.src}`));
        if (!actual.startsWith(`${await realpath(root)}${sep}`)) continue;
        bytes = await readFile(actual);
        break;
      } catch {
        /* A source checkout or a compiled deployment may provide the file. */
      }
    }
    if (!bytes)
      throw new AppError(
        400,
        'CONTENT_ASSET_MISSING',
        `Не найден локальный материал: ${asset.id}.`,
      );
    if (asset.sha256 && createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new AppError(
        400,
        'CONTENT_ASSET_CHANGED',
        `Контрольная сумма материала не совпадает: ${asset.id}.`,
      );
  }
}
function checkVersions(history: Exercise[], next: ContentPackage) {
  const old = new Map<string, Exercise>();
  for (const exercise of history) if (!old.has(exercise.id)) old.set(exercise.id, exercise);
  for (const exercise of next.exercises) {
    const original = old.get(exercise.id);
    if (!original) continue;
    const { version: oldVersion, ...oldBody } = original;
    const { version: newVersion, ...newBody } = exercise;
    if (
      newVersion < oldVersion ||
      (checksum(oldBody) !== checksum(newBody) && newVersion <= oldVersion)
    )
      throw new AppError(
        409,
        'EXERCISE_VERSION_CONFLICT',
        `Увеличьте версию изменённого задания: ${exercise.id}.`,
      );
    if (original.rubric.id === exercise.rubric.id) {
      const { version: oldRubricVersion, ...oldRubric } = original.rubric;
      const { version: newRubricVersion, ...newRubric } = exercise.rubric;
      if (
        newRubricVersion < oldRubricVersion ||
        (checksum(oldRubric) !== checksum(newRubric) && newRubricVersion <= oldRubricVersion)
      )
        throw new AppError(
          409,
          'RUBRIC_VERSION_CONFLICT',
          `Увеличьте версию изменённых критериев: ${exercise.rubric.id}.`,
        );
    }
  }
}
export class ContentService {
  readonly repository: ContentRepository;
  constructor(readonly db: Database) {
    this.repository = new ContentRepository(db);
  }

  async import(value: unknown, actorId: string | null = null) {
    const manifest = parseContent(value);
    await validateContentAssets(manifest);
    const { id, version } = manifest.package;
    const digest = checksum(manifest);
    const counts = {
      routes: manifest.routes.length,
      lessons: manifest.lessons.length,
      exercises: manifest.exercises.length,
      skills: manifest.skills.length,
      sets: manifest.sets.length,
      assets: manifest.assets.length,
    };
    return this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO content_packages (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      const locked = await tx.query<{ current_version: number | null }>(
        'SELECT current_version FROM content_packages WHERE id=$1 FOR UPDATE',
        [id],
      );
      const current = locked.rows[0]!.current_version;
      const existing = await tx.query<{ checksum: string }>(
        'SELECT checksum FROM content_revisions WHERE package_id=$1 AND version=$2',
        [id, version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== digest)
          throw new AppError(
            409,
            'CONTENT_VERSION_CONFLICT',
            'Эта версия пакета уже сохранена с другим содержимым. Увеличьте версию.',
          );
        return {
          packageId: id,
          packageVersion: version,
          currentVersion: current!,
          status: 'unchanged' as const,
          counts,
        };
      }
      if (current !== null) {
        if (version <= current)
          throw new AppError(
            409,
            'CONTENT_VERSION_CONFLICT',
            'Новая версия пакета должна быть больше текущей.',
          );
        const history = await tx.query<{ definition: unknown }>(
          'SELECT definition FROM learning_exercises WHERE package_id=$1 ORDER BY package_version DESC',
          [id],
        );
        checkVersions(
          history.rows.map((row) => exerciseSchema.parse(row.definition)),
          manifest,
        );
      }
      await tx.query(
        'INSERT INTO content_revisions (package_id,version,manifest,checksum,imported_by) VALUES ($1,$2,$3,$4,$5)',
        [id, version, JSON.stringify(manifest), digest, actorId],
      );
      for (const [position, route] of manifest.routes.entries())
        await tx.query(
          'INSERT INTO learning_routes (package_id,package_version,id,position,definition) VALUES ($1,$2,$3,$4,$5)',
          [id, version, route.id, position, JSON.stringify(route)],
        );
      for (const skill of manifest.skills)
        await tx.query(
          'INSERT INTO learning_skills (package_id,package_version,id,definition) VALUES ($1,$2,$3,$4)',
          [id, version, skill.id, JSON.stringify(skill)],
        );
      for (const lesson of manifest.lessons) {
        const position = manifest.routes
          .find((route) => route.id === lesson.routeId)!
          .lessonIds.indexOf(lesson.id);
        await tx.query(
          'INSERT INTO learning_lessons (package_id,package_version,id,route_id,position,definition) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, version, lesson.id, lesson.routeId, position, JSON.stringify(lesson)],
        );
      }
      for (const [position, exercise] of manifest.exercises.entries())
        await tx.query(
          'INSERT INTO learning_exercises (package_id,package_version,id,exercise_version,lesson_id,skill_id,purpose,position,definition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            version,
            exercise.id,
            exercise.version,
            exercise.lessonId,
            exercise.skillId,
            exercise.purpose,
            position,
            JSON.stringify(exercise),
          ],
        );
      for (const set of manifest.sets) {
        await tx.query(
          'INSERT INTO learning_sets (package_id,package_version,id,route_id,purpose,definition) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, version, set.id, set.routeId, set.purpose, JSON.stringify(set)],
        );
        for (const [position, exerciseId] of set.exerciseIds.entries())
          await tx.query(
            'INSERT INTO learning_set_exercises (package_id,package_version,set_id,exercise_id,purpose,position) VALUES ($1,$2,$3,$4,$5,$6)',
            [id, version, set.id, exerciseId, set.purpose, position],
          );
      }
      for (const asset of manifest.assets)
        await tx.query(
          'INSERT INTO learning_assets (package_id,package_version,id,definition) VALUES ($1,$2,$3,$4)',
          [id, version, asset.id, JSON.stringify(asset)],
        );
      await tx.query('UPDATE content_packages SET current_version=$2 WHERE id=$1', [id, version]);
      if (actorId) await audit(tx, actorId, 'content.imported');
      return {
        packageId: id,
        packageVersion: version,
        currentVersion: version,
        status: 'imported' as const,
        counts,
      };
    });
  }
  async export(packageId: string, version?: number) {
    return (await this.repository.revision(packageId, version)).manifest;
  }
}
