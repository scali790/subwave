import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real dispatcher still rescues an unavailable worker through the Piper subprocess boundary', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-ai-piper-'));
  process.env.STATE_DIR = dir;
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tts: { defaultEngine: 'remote', remote: { url: 'http://remote.test' } } }));
  const binary = path.join(dir, 'synthetic-piper');
  writeFileSync(binary, '#!/bin/sh\nwhile [ "$1" != "--output_file" ]; do shift; done\nshift\ncat > "$1"\n');
  chmodSync(binary, 0o700);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => String(url).endsWith('/health')
    ? Response.json({ ok: true })
    : Response.json({ error: 'worker_ready_timeout' }, { status: 503 })) as typeof fetch;
  try {
    const settings = await import('../src/settings.js');
    await settings.load();
    const { config } = await import('../src/config.js');
    config.piper.binary = binary;
    const remote = await import('../src/audio/remoteTts.js');
    await remote.refresh();
    const tts = await import('../src/audio/tts.js');
    const { ttsCalls } = await import('../src/stats.js');
    const rendered = await tts.speak('Back to the music.', { kind: 'dj-speak' });
    assert.equal(readFileSync(rendered, 'utf8'), 'Back to the music.');
    assert.equal(ttsCalls[0].engine, 'piper');
    assert.equal(ttsCalls[0].fellBack, true);
    assert.equal(ttsCalls[0].primary_error_code, 'worker_ready_timeout');
    assert.equal(ttsCalls[0].http_status, 503);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => setTimeout(resolve, 30));
    rmSync(dir, { recursive: true, force: true });
  }
});
