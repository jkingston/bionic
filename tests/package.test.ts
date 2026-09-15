import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('packed SDK works in an external Pi deployment with a separate provider package and SDK copy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bionic-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function run(command: string, args: string[], cwd: string) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  }
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], resolve('.')),
  )[0];
  assert.ok(
    !packed.files.some(
      (file: { path: string }) =>
        file.path.startsWith('tests/') || file.path.startsWith('.bionic/'),
    ),
  );
  const external = join(dir, 'external');
  const platform = join(dir, 'platform');
  mkdirSync(external);
  mkdirSync(platform);
  writeFileSync(
    join(external, 'package.json'),
    JSON.stringify({ name: 'external-deployment', private: true, type: 'module' }),
  );
  writeFileSync(
    join(platform, 'package.json'),
    JSON.stringify({
      name: 'test-platform',
      version: '1.0.0',
      type: 'module',
      peerDependencies: { 'bionic-pi': '0.1.0' },
      pi: { extensions: ['./index.mjs'] },
    }),
  );
  writeFileSync(
    join(platform, 'index.mjs'),
    `
    import { registerBionicProvider, BionicError } from 'bionic-pi/providers';
    export default function(pi) {
      registerBionicProvider(pi, { protocolVersion: 1, id: 'external.platform', provider: {
        definitions: () => [{ name: 'external.echo', version: 1, effect: 'read', description: 'External API',
          inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
        authorize(name, args) { if (args.deny) throw new BionicError('permission_required', 'External scope denied'); },
        async invoke(name, args, ctx) { return { external: true, principal: ctx.principal }; }
      }});
    }
  `,
  );
  // A lockfile install need not cache registry metadata for a new dependency tree.
  // Allow normal npm resolution on fresh runners; install scripts stay disabled.
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--install-links',
      '--no-audit',
      '--no-fund',
      join(dir, packed.filename),
      platform,
    ],
    external,
  );
  // An independently installed provider may resolve a different physical SDK copy.
  writeFileSync(
    join(external, 'types.ts'),
    `
    import { createClockProvider, type ProviderRegistration } from 'bionic-pi/providers';
    const provider: ProviderRegistration = createClockProvider();
    // @ts-expect-error Protocol versions are checked across the published type boundary.
    const invalid: ProviderRegistration['protocolVersion'] = 2;
    void provider; void invalid;
  `,
  );
  run(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      '--skipLibCheck',
      'types.ts',
    ],
    external,
  );
  const installed = join(external, 'node_modules');
  cpSync(join(installed, 'bionic-pi'), join(installed, 'test-platform/node_modules/bionic-pi'), {
    recursive: true,
  });
  writeFileSync(
    join(external, 'smoke.mjs'),
    readFileSync(resolve('tests/fixtures/package-smoke.mjs'), 'utf8'),
  );
  assert.match(run(process.execPath, ['smoke.mjs'], external), /External deployment passed/);
  assert.match(
    run(process.execPath, ['node_modules/bionic-pi/bin/bionic.mjs', '--help'], external),
    /--deployment/,
  );
});
