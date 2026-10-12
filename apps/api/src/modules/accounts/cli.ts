import { z } from 'zod';
import { loadSettings } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { assertSchemaCurrent } from '../../db/migrations.js';
import { bootstrapService, seedDemo } from './bootstrap.js';

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
      console.log(
        `Demo accounts prepared: ${users.map((user) => user.email).join(', ')}. Confirm email and connect Authenticator in the local mailbox.`,
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
      console.log('Superadmin account prepared. Confirm the email and connect Authenticator.');
    } else throw new Error('Use seed-demo or create-admin --email <email>.');
  } finally {
    await database.close();
  }
}
run().catch(() => {
  console.error('Account setup failed. Check the command, account environment and database.');
  process.exitCode = 1;
});
