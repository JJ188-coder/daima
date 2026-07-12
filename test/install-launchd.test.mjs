import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url);

function extractHeredoc(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const bodyStart = source.indexOf('\n', start) + 1;
  const end = source.indexOf(`\n${endMarker}`, bodyStart);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(bodyStart, end);
}

async function loadInstallSource() {
  return readFile(new URL('./install.sh', root), 'utf8');
}

async function createDailyFixture(healthStatus = 'ok', failMatch = '') {
  const source = await loadInstallSource();
  const tempDir = await mkdtemp(join(tmpdir(), 'daima-launchd-test-'));
  const callsPath = join(tempDir, 'calls.log');
  const nodePath = join(tempDir, 'fake-node.sh');
  const wrapperPath = join(tempDir, 'daily.sh');
  const fakeNode = `#!/bin/bash\nif [ "$1" = "-e" ]; then\n  printf '%s\\n' "${healthStatus}"\n  exit 0\nfi\nprintf '%s\\n' "$*" >> "${callsPath}"\nif [ -n "${failMatch}" ] && [[ "$*" == *"${failMatch}"* ]]; then\n  exit 1\nfi\nexit 0\n`;
  let wrapper = extractHeredoc(source, "cat > \"$LOCAL_BIN/daima-huice-daily.sh\" << 'DAILY_EOF'", 'DAILY_EOF');
  wrapper = wrapper
    .replace('__NODE_BIN__', nodePath)
    .replace('__PROJECT_DIR__', tempDir);

  await writeFile(nodePath, fakeNode);
  await writeFile(wrapperPath, wrapper);
  await chmod(nodePath, 0o755);
  await chmod(wrapperPath, 0o755);
  return { callsPath, wrapperPath };
}

test('installer validates plists and reloads each LaunchAgent as a pair', async () => {
  const source = await loadInstallSource();

  assert.match(source, /plutil -lint "\$CDP_PLIST" "\$DAILY_PLIST" "\$SERVER_PLIST"/);
  assert.match(source, /for PLIST in "\$SERVER_PLIST" "\$DAILY_PLIST" "\$CDP_PLIST"/);
  assert.match(source, /launchctl bootout "\$LAUNCH_DOMAIN" "\$PLIST"[\s\S]*launchctl bootstrap "\$LAUNCH_DOMAIN" "\$PLIST"/);
});

test('server LaunchAgent wrapper keeps Node in the foreground', async () => {
  const source = await loadInstallSource();
  const wrapper = extractHeredoc(source, 'cat > "$LOCAL_BIN/daima-huice-server.sh" << EOF', 'EOF');

  assert.match(wrapper, /exec "\\\$NODE_BIN" "\\\$PROJECT_DIR\/tools\/huice-server\.mjs"/);
  assert.doesNotMatch(wrapper, /nohup/);
  assert.doesNotMatch(wrapper, /huice-server\.mjs[^\n]*&/);
});

test('daily LaunchAgent wrapper runs remaining collectors and returns failure', async () => {
  const { callsPath, wrapperPath } = await createDailyFixture('ok', 'huice-export-cdp.mjs');
  const result = spawnSync('/bin/bash', [wrapperPath], { encoding: 'utf8' });
  const calls = await readFile(callsPath, 'utf8');

  assert.notEqual(result.status, 0);
  assert.match(calls, /huice-export-cdp\.mjs/);
  assert.match(calls, /write-storage\.mjs/);
  assert.match(calls, /huice-shop-export-cdp\.mjs/);
  assert.match(calls, /pdd-promo-cdp\.mjs/);
  assert.match(result.stdout, /存在失败步骤/);
  assert.doesNotMatch(result.stdout, /✅ 每日同步完成/);
});

test('daily LaunchAgent wrapper returns success when every step succeeds', async () => {
  const { wrapperPath } = await createDailyFixture();
  const result = spawnSync('/bin/bash', [wrapperPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /✅ 每日同步完成/);
});

for (const healthStatus of ['no_cdp', 'timeout', 'no_hjy', 'parse_error', '']) {
  test(`daily LaunchAgent wrapper rejects CDP status: ${healthStatus || 'empty'}`, async () => {
    const { wrapperPath } = await createDailyFixture(healthStatus);
    const result = spawnSync('/bin/bash', [wrapperPath], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
  });
}
