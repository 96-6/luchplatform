import { z } from 'zod';
import {
  assetSchema,
  contentPackageSchema,
  exerciseSchema,
  exerciseSetSchema,
  learningRouteSchema,
  lessonSchema,
  skillSchema,
  type ContentBlock,
  type Exercise,
  type ExerciseView,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';

export function exerciseView(exercise: Exercise): ExerciseView {
  return {
    id: exercise.id,
    version: exercise.version,
    lessonId: exercise.lessonId,
    skillId: exercise.skillId,
    language: exercise.language,
    level: exercise.level,
    purpose: exercise.purpose,
    instruction: exercise.instruction,
    blocks: exercise.blocks,
    response: exercise.response,
    author: exercise.author,
    license: exercise.license,
  };
}
const definitions = {
  routes: { table: 'learning_routes', schema: learningRouteSchema },
  skills: { table: 'learning_skills', schema: skillSchema },
  lessons: { table: 'learning_lessons', schema: lessonSchema },
  exercises: { table: 'learning_exercises', schema: exerciseSchema },
  sets: { table: 'learning_sets', schema: exerciseSetSchema },
  assets: { table: 'learning_assets', schema: assetSchema },
};
const notFound = () => new AppError(404, 'CONTENT_NOT_FOUND', 'Учебный материал не найден.');
export class ContentRepository {
  constructor(readonly db: Database) {}

  async revision(packageId: string, requestedVersion?: number, tx: QueryExecutor = this.db) {
    const result = await tx.query<{ version: number; manifest: unknown }>(
      `SELECT r.version,r.manifest FROM content_packages p JOIN content_revisions r
       ON r.package_id=p.id AND r.version=COALESCE($2::integer,p.current_version) WHERE p.id=$1`,
      [packageId, requestedVersion ?? null],
    );
    const row = result.rows[0];
    if (!row) throw notFound();
    const manifest = contentPackageSchema.parse(row.manifest);
    return { packageId, packageVersion: row.version, isDemo: manifest.package.isDemo, manifest };
  }
  async definition<K extends keyof typeof definitions>(
    key: K,
    packageId: string,
    packageVersion: number,
    id: string,
  ) {
    const { table, schema } = definitions[key];
    const result = await this.db.query<{ definition: unknown }>(
      `SELECT definition FROM ${table} WHERE package_id=$1 AND package_version=$2 AND id=$3`,
      [packageId, packageVersion, id],
    );
    if (!result.rows[0]) throw notFound();
    return schema.parse(result.rows[0].definition) as z.infer<(typeof definitions)[K]['schema']>;
  }
  async catalog() {
    const result = await this.db.query<{
      package_id: string;
      package_version: number;
      definition: unknown;
      manifest: unknown;
    }>(
      `SELECT r.package_id,r.package_version,r.definition,v.manifest FROM learning_routes r
       JOIN content_packages p ON p.id=r.package_id AND p.current_version=r.package_version
       JOIN content_revisions v ON v.package_id=p.id AND v.version=p.current_version
       ORDER BY r.package_id,r.position`,
    );
    return result.rows.map((row) => {
      const { lessonIds, ...route } = learningRouteSchema.parse(row.definition);
      return {
        ...route,
        packageId: row.package_id,
        packageVersion: row.package_version,
        isDemo: contentPackageSchema.parse(row.manifest).package.isDemo,
        lessonCount: lessonIds.length,
      };
    });
  }
  async packages() {
    const result = await this.db.query<{ manifest: unknown }>(
      `SELECT r.manifest FROM content_packages p JOIN content_revisions r
       ON r.package_id=p.id AND r.version=p.current_version ORDER BY p.id`,
    );
    return result.rows.map((row) => {
      const info = contentPackageSchema.parse(row.manifest).package;
      return { id: info.id, title: info.title, currentVersion: info.version, isDemo: info.isDemo };
    });
  }
  async route(packageId: string, id: string, requestedVersion?: number) {
    const { packageVersion, isDemo } = await this.revision(packageId, requestedVersion);
    const route = await this.definition('routes', packageId, packageVersion, id);
    const lessons = await this.db.query<{ definition: unknown }>(
      'SELECT definition FROM learning_lessons WHERE package_id=$1 AND package_version=$2 AND route_id=$3 ORDER BY position',
      [packageId, packageVersion, id],
    );
    const sets = await this.db.query<{ definition: unknown }>(
      'SELECT definition FROM learning_sets WHERE package_id=$1 AND package_version=$2 AND route_id=$3 ORDER BY purpose,id',
      [packageId, packageVersion, id],
    );
    const lessonDefinitions = lessons.rows.map((row) => lessonSchema.parse(row.definition));
    const skillIds = [...new Set(lessonDefinitions.flatMap((lesson) => lesson.skillIds))];
    const skills = await Promise.all(
      skillIds.map((skillId) => this.definition('skills', packageId, packageVersion, skillId)),
    );
    return {
      ...route,
      packageId,
      packageVersion,
      isDemo,
      lessons: lessonDefinitions,
      skills,
      sets: sets.rows.map((row) => exerciseSetSchema.parse(row.definition)),
    };
  }
  private async assets(packageId: string, packageVersion: number, blocks: ContentBlock[]) {
    const ids = [
      ...new Set(blocks.flatMap((block) => ('assetId' in block ? [block.assetId] : []))),
    ];
    return Promise.all(ids.map((id) => this.definition('assets', packageId, packageVersion, id)));
  }
  async lesson(packageId: string, id: string, purpose: string, requestedVersion?: number) {
    const { packageVersion, isDemo } = await this.revision(packageId, requestedVersion);
    const lesson = await this.definition('lessons', packageId, packageVersion, id);
    const result = await this.db.query<{ definition: unknown }>(
      'SELECT definition FROM learning_exercises WHERE package_id=$1 AND package_version=$2 AND lesson_id=$3 AND purpose=$4 ORDER BY position',
      [packageId, packageVersion, id, purpose],
    );
    const exercises = result.rows.map((row) => exerciseView(exerciseSchema.parse(row.definition)));
    const skills = await Promise.all(
      lesson.skillIds.map((skillId) =>
        this.definition('skills', packageId, packageVersion, skillId),
      ),
    );
    const assets = await this.assets(packageId, packageVersion, [
      ...lesson.blocks,
      ...exercises.flatMap((exercise) => exercise.blocks),
    ]);
    return { ...lesson, packageId, packageVersion, isDemo, exercises, skills, assets };
  }
  async set(packageId: string, id: string, requestedVersion?: number) {
    const { packageVersion, isDemo } = await this.revision(packageId, requestedVersion);
    const set = await this.definition('sets', packageId, packageVersion, id);
    const result = await this.db.query<{ definition: unknown }>(
      `SELECT e.definition FROM learning_set_exercises m JOIN learning_exercises e
       ON e.package_id=m.package_id AND e.package_version=m.package_version AND e.id=m.exercise_id
       WHERE m.package_id=$1 AND m.package_version=$2 AND m.set_id=$3 ORDER BY m.position`,
      [packageId, packageVersion, id],
    );
    const exercises = result.rows.map((row) => exerciseView(exerciseSchema.parse(row.definition)));
    const assets = await this.assets(
      packageId,
      packageVersion,
      exercises.flatMap((exercise) => exercise.blocks),
    );
    return { ...set, packageId, packageVersion, isDemo, exercises, assets };
  }
}
