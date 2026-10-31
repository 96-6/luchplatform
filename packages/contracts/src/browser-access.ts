import { z } from 'zod';
import { browserIdSchema } from './browsers.js';
const person = z.object({ id: z.uuid(), name: z.string(), email: z.string() });
const cursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
export const browserAccessPageQuerySchema = z
  .strictObject({
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(
    (x) => Boolean(x.beforeCreatedAt) === Boolean(x.beforeId),
    'Поля курсора требуются вместе.',
  );
export const createBrowserAccessLinkSchema = z.strictObject({
  operationId: z.uuid(),
  label: z.string().trim().min(1).max(120),
  singleUse: z.boolean(),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export const browserAccessLinkSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  singleUse: z.boolean(),
  url: z.string(),
  creator: person,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: person.nullable(),
  status: z.enum(['active', 'used', 'expired', 'revoked']),
  totalDevices: z.number().int().nonnegative(),
  activeDevices: z.number().int().nonnegative(),
});
export const browserAccessLinksSchema = z.object({
  items: z.array(browserAccessLinkSchema),
  nextCursor: cursor.nullable(),
});
export const browserAccessDeviceSchema = z.object({
  id: z.uuid(),
  linkId: z.uuid(),
  label: z.string(),
  browser: browserIdSchema,
  platform: z.string(),
  userAgent: z.string(),
  firstIp: z.string(),
  lastIp: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUser: person.nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: person.nullable(),
  active: z.boolean(),
});
export const browserAccessDevicesSchema = z.object({
  items: z.array(browserAccessDeviceSchema),
  nextCursor: cursor.nullable(),
});
export type BrowserAccessLink = z.infer<typeof browserAccessLinkSchema>;
export type BrowserAccessDevice = z.infer<typeof browserAccessDeviceSchema>;
