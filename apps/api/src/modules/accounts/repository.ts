import { randomUUID } from 'node:crypto';
import type { User } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';

export type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: User['role'];
  email_verified_at: Date | string | null;
  totp_secret_ciphertext: string | null;
  totp_enabled_at: Date | string | null;
  last_totp_counter: string | number;
  password_hash_ciphertext: string | null;
  password_changed_at: Date | string | null;
  auth_revision: number;
  is_demo: boolean;
  is_blocked: boolean;
  is_active: boolean;
  block_reason: string;
  access_verified: boolean;
  created_at: Date | string;
};
export function publicUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.full_name,
    role: row.role,
    emailVerified: Boolean(row.email_verified_at),
    authenticatorEnabled: Boolean(row.totp_enabled_at),
    passwordConfigured: Boolean(row.password_hash_ciphertext),
    isDemo: row.is_demo,
    isBlocked: row.is_blocked,
    isActive: row.is_active,
    blockReason: '',
    accessVerified: row.access_verified,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
// Ban reasons belong to account management and the authenticated sign-in refusal.
export function managementUser(row: UserRow): User {
  return { ...publicUser(row), blockReason: row.block_reason };
}
export const dashboardPath = (role: User['role']) =>
  role === 'superadmin'
    ? '/admin'
    : role === 'admin'
      ? '/operations'
      : role === 'teacher'
        ? '/teacher'
        : '/student';
export async function audit(
  db: QueryExecutor,
  actorId: string | null,
  action: string,
  targetId: string | null = null,
) {
  await db.query(
    'INSERT INTO security_audit (id, actor_id, target_id, action) VALUES ($1,$2,$3,$4)',
    [randomUUID(), actorId, targetId, action],
  );
}
