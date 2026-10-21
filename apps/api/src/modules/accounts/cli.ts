import { z } from 'zod';
import { loadSettings } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { assertSchemaCurrent } from '../../db/migrations.js';
import { bootstrapService, seedDemo } from './bootstrap.js';
import { seedDemoContent } from '../content/bootstrap.js';

async function run() {
  const settings = loadSettings();
  const database = await createDatabase(settings);
  try {
    await assertSchemaCurrent(database);
    if (process.argv[2] === 'security-reset') {
      await database.query(
        'UPDATE security_policy SET vpn_check_enabled=false,revision=revision+1,updated_at=now(),updated_by=NULL WHERE id=1',
      );
      console.log('Network access restriction disabled.');
    } else if (process.argv[2] === 'seed-demo') {
      const users = await seedDemo(database, settings);
      const content = await seedDemoContent(database);
      console.log(
        `Demo content: ${content.status}; package ${content.packageId} v${content.packageVersion}.`,
      );
      console.log(
        `Demo accounts prepared: ${users.map((user) => user.email).join(', ')}. Set a password using the local mailbox, then sign in and connect Authenticator.`,
      );
    } else if (process.argv[2] === 'create-admin') {
      const args = process.argv.slice(3);
      if (!args.includes('--email')) throw new Error('Email is required.');
      const email = z.email().parse(args[args.indexOf('--email') + 1]);
      const name = args.includes('--name')
        ? z
            .string()
            .min(2)
            .max(100)
            .parse(args[args.indexOf('--name') + 1])
        : 'Суперадмин';
      await bootstrapService(database, settings).provision(email, name, 'superadmin', false);
      console.log(
        'Superadmin account prepared. Set a password using the email link, then sign in and connect Authenticator.',
      );
    } else throw new Error('Use seed-demo or create-admin --email <email>.');
  } finally {
    await database.close();
  }
}
run().catch(() => {
  console.error('Account setup failed. Check the command, account environment and database.');
  process.exitCode = 1;
});
