import type { Settings } from '../../config.js';
import type { Database } from '../../db/database.js';
import { AccountCrypto } from '../auth/crypto.js';
import { AuthService } from '../auth/service.js';
import { MailService } from '../mail/service.js';
import { NetworkService } from '../security/network.js';

export function bootstrapService(database: Database, settings: Settings) {
  const crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY);
  return new AuthService(
    database,
    settings,
    crypto,
    new MailService(database, settings, crypto),
    new NetworkService(database, settings, crypto),
  );
}
export async function seedDemo(database: Database, settings: Settings) {
  if (settings.APP_ENV === 'production' || settings.MAIL_MODE !== 'local')
    throw new Error('Demo seeding requires a local development/test mailbox.');
  const service = bootstrapService(database, settings);
  const student = await service.provision('student@example.test', 'Демо-ученик', 'student', true);
  const teacher = await service.provision(
    'teacher@example.test',
    'Демо-преподаватель',
    'teacher',
    true,
  );
  const admin = await service.provision(
    'admin@example.test',
    'Демо-суперадмин',
    'superadmin',
    true,
  );
  await database.query(
    'INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [teacher.id, student.id],
  );
  return [student, teacher, admin];
}
