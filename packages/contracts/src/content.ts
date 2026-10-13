import { z } from 'zod';

export const contentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const label = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(5000);
const version = z.number().int().min(1).max(1_000_000);
export const languageSchema = z.enum(['ru', 'en']);
export const levelSchema = z.enum(['A1', 'A2']);
export const exercisePurposeSchema = z.enum(['diagnostic', 'practice', 'control']);
const attribution = { author: label, license: label };
const ids = z.array(contentIdSchema).min(1).max(1200);

export const assetSchema = z
  .strictObject({
    id: contentIdSchema,
    kind: z.enum(['image', 'audio', 'video', 'file']),
    src: z
      .string()
      .max(2048)
      .refine((src) => {
        if (/^\/learning-media\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(src))
          return !src.includes('..') && !src.includes('//');
        try {
          const url = new URL(src);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'Use /learning-media/... or an HTTPS URL without credentials.'),
    mediaType: z.enum([
      'image/svg+xml',
      'image/png',
      'image/jpeg',
      'image/webp',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'video/mp4',
      'video/webm',
      'application/pdf',
      'text/plain',
    ]),
    ...attribution,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((asset, ctx) => {
    const valid =
      asset.kind === 'file'
        ? ['application/pdf', 'text/plain'].includes(asset.mediaType)
        : asset.mediaType.startsWith(`${asset.kind}/`);
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        path: ['mediaType'],
        message: 'Media type does not match asset kind.',
      });
  });

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), id: contentIdSchema, heading: label.optional(), text }),
  z.strictObject({
    type: z.literal('vocabulary'),
    id: contentIdSchema,
    heading: label.optional(),
    items: z
      .array(z.strictObject({ term: label, translation: label, example: text.optional() }))
      .min(1)
      .max(100),
  }),
  z.strictObject({
    type: z.literal('dialogue'),
    id: contentIdSchema,
    heading: label.optional(),
    lines: z
      .array(z.strictObject({ speaker: label, text }))
      .min(1)
      .max(100),
  }),
  z.strictObject({
    type: z.literal('image'),
    id: contentIdSchema,
    assetId: contentIdSchema,
    alt: label,
    caption: text.optional(),
  }),
  z.strictObject({
    type: z.literal('audio'),
    id: contentIdSchema,
    assetId: contentIdSchema,
    transcript: text,
    caption: label.optional(),
  }),
  z.strictObject({
    type: z.literal('video'),
    id: contentIdSchema,
    assetId: contentIdSchema,
    transcript: text,
    caption: label.optional(),
  }),
  z.strictObject({
    type: z.literal('file'),
    id: contentIdSchema,
    assetId: contentIdSchema,
    label,
    description: text.optional(),
  }),
]);
const blocks = z.array(contentBlockSchema).max(100);
export const skillSchema = z.strictObject({
  id: contentIdSchema,
  title: label,
  description: text,
  language: languageSchema,
  level: levelSchema,
});
export const learningRouteSchema = z.strictObject({
  id: contentIdSchema,
  title: label,
  description: text,
  language: languageSchema,
  level: levelSchema,
  goals: z.array(label).min(1).max(20),
  lessonIds: z.array(contentIdSchema).min(1).max(300),
});
export const lessonSchema = z.strictObject({
  id: contentIdSchema,
  routeId: contentIdSchema,
  title: label,
  summary: text,
  estimatedMinutes: z.number().int().min(1).max(120),
  skillIds: z.array(contentIdSchema).min(1).max(50),
  blocks: blocks.min(1),
});

const option = z.strictObject({ id: contentIdSchema, text: label });
export const responseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('choice'), options: z.array(option).min(2).max(12) }),
  z.strictObject({
    type: z.literal('short_text'),
    maxLength: z.number().int().min(1).max(1000),
    placeholder: label.optional(),
  }),
]);
const solutionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    correctOptionIds: z.array(contentIdSchema).length(1),
  }),
  z.strictObject({
    type: z.literal('short_text'),
    accepted: z
      .array(
        z
          .string()
          .min(1)
          .max(1000)
          .refine((answer) => answer.trim().length > 0, 'Answer cannot be blank.'),
      )
      .min(1)
      .max(30),
    normalization: z.strictObject({
      trim: z.boolean(),
      collapseWhitespace: z.boolean(),
      caseSensitive: z.boolean(),
      unicode: z.literal('NFKC'),
    }),
  }),
]);
export const exerciseSchema = z
  .strictObject({
    id: contentIdSchema,
    version,
    lessonId: contentIdSchema,
    skillId: contentIdSchema,
    language: languageSchema,
    level: levelSchema,
    purpose: exercisePurposeSchema,
    instruction: text,
    listening: z.strictObject({ text: z.string().trim().min(1).max(3000) }).optional(),
    blocks,
    response: responseSchema,
    solution: solutionSchema,
    explanation: text,
    hints: z.array(text).max(10),
    rubric: z.strictObject({
      id: contentIdSchema,
      version,
      maxScore: z.literal(1),
      criteria: z.array(text).min(1).max(10),
    }),
    ...attribution,
    review: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('demo') }),
      z.strictObject({
        status: z.literal('approved'),
        reviewer: label,
        reviewedAt: z.iso.datetime(),
      }),
    ]),
  })
  .superRefine((exercise, ctx) => {
    if (exercise.response.type !== exercise.solution.type)
      ctx.addIssue({
        code: 'custom',
        path: ['solution'],
        message: 'Answer and solution types must match.',
      });
    if (exercise.response.type === 'choice' && exercise.solution.type === 'choice') {
      const optionIds = exercise.response.options.map((item) => item.id);
      if (
        new Set(optionIds).size !== optionIds.length ||
        !optionIds.includes(exercise.solution.correctOptionIds[0]!)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['response'],
          message: 'Options must be unique and include the correct answer.',
        });
    }
    if (exercise.response.type === 'short_text' && exercise.solution.type === 'short_text') {
      const maxLength = exercise.response.maxLength;
      if (exercise.solution.accepted.some((answer) => answer.length > maxLength))
        ctx.addIssue({
          code: 'custom',
          path: ['solution', 'accepted'],
          message: 'Accepted answer exceeds maxLength.',
        });
    }
    if (exercise.purpose === 'control' && exercise.hints.length)
      ctx.addIssue({
        code: 'custom',
        path: ['hints'],
        message: 'Control exercises cannot contain hints.',
      });
  });
export const exerciseSetSchema = z.strictObject({
  id: contentIdSchema,
  routeId: contentIdSchema,
  title: label,
  purpose: exercisePurposeSchema,
  exerciseIds: ids,
});

export const contentPackageSchema = z
  .strictObject({
    format: z.literal('luch-content'),
    formatVersion: z.literal(1),
    package: z.strictObject({
      id: contentIdSchema,
      version,
      title: label,
      ...attribution,
      isDemo: z.boolean(),
    }),
    assets: z.array(assetSchema).max(200),
    skills: z.array(skillSchema).min(1).max(300),
    routes: z.array(learningRouteSchema).min(1).max(50),
    lessons: z.array(lessonSchema).min(1).max(300),
    exercises: z.array(exerciseSchema).min(1).max(1200),
    sets: z.array(exerciseSetSchema).min(1).max(150),
  })
  .superRefine((manifest, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    for (const key of ['assets', 'skills', 'routes', 'lessons', 'exercises', 'sets'] as const) {
      const seen = new Set<string>();
      manifest[key].forEach((entry, index) => {
        if (seen.has(entry.id)) issue([key, index, 'id'], 'Duplicate ID.');
        seen.add(entry.id);
      });
    }
    const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    const skills = new Map(manifest.skills.map((skill) => [skill.id, skill]));
    const routes = new Map(manifest.routes.map((route) => [route.id, route]));
    const lessons = new Map(manifest.lessons.map((lesson) => [lesson.id, lesson]));
    const exercises = new Map(manifest.exercises.map((exercise) => [exercise.id, exercise]));
    const validateBlocks = (items: z.infer<typeof blocks>, path: (string | number)[]) => {
      const seen = new Set<string>();
      items.forEach((block, i) => {
        if (seen.has(block.id)) issue([...path, i, 'id'], 'Duplicate block ID.');
        seen.add(block.id);
        if ('assetId' in block && assets.get(block.assetId)?.kind !== block.type)
          issue([...path, i, 'assetId'], 'Unknown asset or mismatched asset kind.');
      });
    };
    manifest.routes.forEach((route, i) => {
      if (new Set(route.lessonIds).size !== route.lessonIds.length)
        issue(['routes', i, 'lessonIds'], 'Duplicate lesson reference.');
      route.lessonIds.forEach((id) => {
        if (lessons.get(id)?.routeId !== route.id)
          issue(['routes', i, 'lessonIds'], `Unknown or foreign lesson: ${id}.`);
      });
    });
    manifest.lessons.forEach((lesson, i) => {
      const route = routes.get(lesson.routeId);
      if (!route?.lessonIds.includes(lesson.id))
        issue(
          ['lessons', i, 'routeId'],
          'Lesson must belong to a route and its ordered lesson list.',
        );
      if (new Set(lesson.skillIds).size !== lesson.skillIds.length)
        issue(['lessons', i, 'skillIds'], 'Duplicate skill reference.');
      for (const id of lesson.skillIds)
        if (skills.get(id)?.language !== route?.language || skills.get(id)?.level !== route?.level)
          issue(['lessons', i, 'skillIds'], `Unknown skill or mismatched language/level: ${id}.`);
      validateBlocks(lesson.blocks, ['lessons', i, 'blocks']);
    });
    manifest.exercises.forEach((exercise, i) => {
      const lesson = lessons.get(exercise.lessonId);
      const skill = skills.get(exercise.skillId);
      if (
        !lesson?.skillIds.includes(exercise.skillId) ||
        skill?.language !== exercise.language ||
        skill?.level !== exercise.level
      )
        issue(
          ['exercises', i, 'skillId'],
          'Exercise must reference a lesson skill of the same language and level.',
        );
      if (
        !manifest.package.isDemo &&
        exercise.purpose === 'control' &&
        exercise.review.status !== 'approved'
      )
        issue(['exercises', i, 'review'], 'Non-demo control exercises require editorial approval.');
      validateBlocks(exercise.blocks, ['exercises', i, 'blocks']);
    });
    const included = new Set<string>();
    manifest.sets.forEach((set, i) => {
      if (!routes.has(set.routeId)) issue(['sets', i, 'routeId'], 'Unknown route.');
      if (new Set(set.exerciseIds).size !== set.exerciseIds.length)
        issue(['sets', i, 'exerciseIds'], 'Duplicate exercise reference.');
      set.exerciseIds.forEach((id) => {
        const exercise = exercises.get(id);
        if (
          !exercise ||
          exercise.purpose !== set.purpose ||
          lessons.get(exercise.lessonId)?.routeId !== set.routeId
        )
          issue(['sets', i, 'exerciseIds'], `Unknown exercise or mismatched route/purpose: ${id}.`);
        included.add(id);
      });
    });
    manifest.exercises.forEach((exercise, i) => {
      if (!included.has(exercise.id))
        issue(['exercises', i, 'id'], 'Exercise must belong to a set.');
    });
  });

// Deliberately exclude evaluation data from every learner-facing payload.
export const exerciseViewSchema = z.strictObject({
  id: contentIdSchema,
  version,
  lessonId: contentIdSchema,
  skillId: contentIdSchema,
  language: languageSchema,
  level: levelSchema,
  purpose: exercisePurposeSchema,
  instruction: text,
  hasListening: z.boolean(),
  blocks,
  response: responseSchema,
  ...attribution,
});
export const contentReferenceSchema = z.object({
  packageId: contentIdSchema,
  packageVersion: version,
  isDemo: z.boolean(),
});
export const routeSummarySchema = learningRouteSchema
  .omit({ lessonIds: true })
  .extend({ ...contentReferenceSchema.shape, lessonCount: z.number().int().min(1) });
export const catalogSchema = z.array(routeSummarySchema);
export const routeViewSchema = learningRouteSchema.extend({
  ...contentReferenceSchema.shape,
  lessons: z.array(lessonSchema),
  skills: z.array(skillSchema),
  sets: z.array(exerciseSetSchema),
});
export const lessonViewSchema = lessonSchema.extend({
  ...contentReferenceSchema.shape,
  exercises: z.array(exerciseViewSchema),
  skills: z.array(skillSchema),
  assets: z.array(assetSchema),
});
export const setViewSchema = exerciseSetSchema.extend({
  ...contentReferenceSchema.shape,
  exercises: z.array(exerciseViewSchema),
  assets: z.array(assetSchema),
});
export const contentPackagesSchema = z.array(
  z.object({ id: contentIdSchema, title: label, currentVersion: version, isDemo: z.boolean() }),
);
export const importResultSchema = z.object({
  packageId: contentIdSchema,
  packageVersion: version,
  currentVersion: version,
  status: z.enum(['imported', 'unchanged']),
  counts: z.object({
    routes: z.number().int(),
    lessons: z.number().int(),
    exercises: z.number().int(),
    skills: z.number().int(),
    sets: z.number().int(),
    assets: z.number().int(),
  }),
});
export const CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export type ContentPackage = z.infer<typeof contentPackageSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ContentAsset = z.infer<typeof assetSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type ExerciseView = z.infer<typeof exerciseViewSchema>;
export type ExercisePurpose = z.infer<typeof exercisePurposeSchema>;
