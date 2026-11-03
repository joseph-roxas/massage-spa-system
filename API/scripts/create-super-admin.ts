// Creates (or resets) the Super Admin login directly in D1.
//
//   npm run admin:create -w API              # local database
//   D1_DATABASE_ID=<id> npm run admin:create -w API -- --remote
//
// Run with Node's built-in TypeScript support; no build step.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.ts';

const API_DIR = join(import.meta.dirname, '..');
const remote = process.argv.includes('--remote');

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const writeToOutput = rl as unknown as { _writeToOutput: (s: string) => void };
const echo = writeToOutput._writeToOutput.bind(rl);

// Reading lines from one iterator (rather than rl.question) also works when answers are piped in.
const lines = rl[Symbol.asyncIterator]();

async function ask(question: string, { hidden = false, fallback = '' } = {}): Promise<string> {
  const label = fallback ? `${question}[${fallback}] ` : question;
  process.stdout.write(label);
  // Echo nothing while a password is typed.
  writeToOutput._writeToOutput = hidden ? () => {} : echo;
  const { value } = await lines.next();
  writeToOutput._writeToOutput = echo;
  if (hidden) process.stdout.write('\n');
  return (typeof value === 'string' ? value.trim() : '') || fallback;
}

const sql = (v: string) => `'${v.replace(/'/g, "''")}'`;

const firstName = await ask('First name: ');
const lastName = await ask('Last name: ');
const email = (await ask('Email: ', { fallback: 'desiree.ababon@gmail.com' })).toLowerCase();
const password = await ask(`Password (min ${MIN_PASSWORD_LENGTH} chars): `, { hidden: true });
rl.close();
if (!firstName || !lastName || password.length < MIN_PASSWORD_LENGTH) {
  console.error('First name, last name and a long enough password are required.');
  process.exit(1);
}

const now = new Date().toISOString();
const statement = `INSERT INTO users (id, first_name, last_name, email, password_hash, role, status, must_change_password, created_at, decided_at)
VALUES (${sql(crypto.randomUUID())}, ${sql(firstName)}, ${sql(lastName)}, ${sql(email)}, ${sql(await hashPassword(password))}, 'super_admin', 'active', 0, ${sql(now)}, ${sql(now)})
ON CONFLICT(email) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
  password_hash = excluded.password_hash, role = 'super_admin', status = 'active', must_change_password = 0, decided_at = excluded.decided_at;`;

const sqlFile = join(API_DIR, '.super-admin.sql');
const tempConfig = join(API_DIR, '.wrangler-remote.toml');
writeFileSync(sqlFile, statement);

const args = ['wrangler', 'd1', 'execute', 'massage-spa-db', '--file', sqlFile];
if (remote) {
  const id = process.env.D1_DATABASE_ID;
  if (!id) {
    console.error('Set D1_DATABASE_ID to the production database id.');
    process.exit(1);
  }
  const config = readFileSync(join(API_DIR, 'wrangler.toml'), 'utf8').replace('D1_DATABASE_ID_PLACEHOLDER', id);
  writeFileSync(tempConfig, config);
  args.push('--remote', '--config', tempConfig);
} else {
  args.push('--local', '--persist-to', '../.wrangler-state');
}

try {
  // A shell is needed for npx on Windows, so quote each argument ourselves.
  const command = `npx ${args.map((a) => `"${a}"`).join(' ')}`;
  const result = spawnSync(command, { cwd: API_DIR, stdio: 'inherit', shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Super Admin ${email} is ready on the ${remote ? 'production' : 'local'} database.`);
} finally {
  rmSync(sqlFile, { force: true });
  rmSync(tempConfig, { force: true });
}
