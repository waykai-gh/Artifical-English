import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { prepare } from './prepare-production.mjs';

mkdirSync('.tmp', {recursive:true});
const directory = mkdtempSync(resolve('.tmp/compose-check-'));
copyFileSync('compose.yaml', join(directory, 'compose.yaml'));
writeFileSync(join(directory, 'compose.env'), '');
writeFileSync(join(directory, '.env'), "POSTGRES_PASSWORD='synthetic-strong-$LITERAL-value'\nGROQ_API_KEY='synthetic-$LITERAL-key'\nPassword='unrelated-secret'\n");
prepare(join(directory, '.env'), join(directory, 'deploy'));
const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', join(directory, 'compose.env'), '-f', join(directory, 'compose.yaml'), 'config', '--format', 'json'], { encoding: 'utf8' }));
// Compose serializes literal dollars as $$ when rendering a reusable config.
assert.equal(config.services.bot.environment.GROQ_API_KEY.replaceAll('$$', '$'), 'synthetic-$LITERAL-key');
assert.equal(config.services.bot.environment.Password, undefined);
assert.equal(config.services.db.environment.POSTGRES_PASSWORD, undefined);
assert.equal(config.services.db.ports[0].host_ip, '127.0.0.1');
assert.equal(config.services.bot.read_only, true);
assert.deepEqual(config.services.bot.cap_drop, ['ALL']);
assert.ok(config.services.bot.healthcheck);
assert.ok(config.services.bot.security_opt.includes('no-new-privileges:true'));
console.log('Compose: explicit credentials, literal dollar signs, isolation and health checks verified.');
if (process.argv[2]) {
  const override = join(directory, 'image.json');
  writeFileSync(override, JSON.stringify({services:{bot:{image:process.argv[2]}}}));
  const args = ['compose', '--env-file', join(directory, 'compose.env'), '-f', join(directory, 'compose.yaml'), '-f', override];
  try {
    execFileSync('docker', [...args, 'run', '--rm', '-T', '--no-deps', '--pull', 'never', 'bot', 'node', '-e',
      "require('node:assert/strict').equal(process.env.GROQ_API_KEY, 'synthetic-$LITERAL-key'); if(process.env.Password)process.exit(1); console.log('Actual Compose container preserves literal dollar signs and excludes unrelated credentials.')"], {stdio:'inherit'});
  } finally { execFileSync('docker', [...args, 'down'], {stdio:'inherit'}); }
}
