import { z } from 'zod';
export const maintenanceKindSchema = z.enum([
  'recover_learning',
  'retry_video',
  'seed_content',
  'expire_audio',
]);
export const maintenanceInputSchema = z.strictObject({
  operationId: z.uuid(),
  kind: maintenanceKindSchema,
});
export const maintenanceOperationSchema = z.object({
  id: z.uuid(),
  kind: maintenanceKindSchema,
  status: z.enum(['running', 'completed', 'failed']),
  actorName: z.string(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  result: z
    .object({ message: z.string(), processed: z.number().int().nonnegative().optional() })
    .nullable(),
});
export const operationsOverviewSchema = z.object({
  database: z.literal('ready'),
  schemaVersion: z.string(),
  refreshedAt: z.iso.datetime(),
  canManagePlatform: z.boolean(),
  counts: z.object({
    students: z.number().int().nonnegative(),
    teachers: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(),
    lessons: z.number().int().nonnegative(),
    liveMeetings: z.number().int().nonnegative(),
    scheduledMeetings: z.number().int().nonnegative(),
    learningReady: z.number().int().nonnegative(),
    learningDeferred: z.number().int().nonnegative(),
    videoPending: z.number().int().nonnegative(),
    speechErrors: z.number().int().nonnegative(),
    unknownProviderRequests: z.number().int().nonnegative(),
    expiredAudio: z.number().int().nonnegative(),
  }),
  integrations: z.array(
    z.object({ id: z.string(), title: z.string(), configured: z.boolean(), detail: z.string() }),
  ),
  actions: z.array(maintenanceKindSchema),
  recentOperations: z.array(maintenanceOperationSchema),
});
export type MaintenanceOperation = z.infer<typeof maintenanceOperationSchema>;
export type MaintenanceKind = z.infer<typeof maintenanceKindSchema>;
