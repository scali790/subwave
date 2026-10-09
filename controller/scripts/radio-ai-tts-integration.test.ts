import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('actual dispatcher rejects oversize before POST/Piper; backend rejection also cannot rescue', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-ai-tts-'));
  process.env.STATE_DIR = dir;
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    tts: { defaultEngine: 'remote', remote: { url: 'http://remote.test' } },
  }));
  const realFetch = globalThis.fetch;
  let posts = 0;
  let backendRejects = false;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).endsWith('/health')) return Response.json({ ok: true, capabilities: {
      schema_version: 1, max_text_chars: 600, text_normalization: 'python-whitespace-codepoints-v1',
      voices: ['marlowe:v1', 'wren:v1', 'hale:v1'], default_voice: 'marlowe:v1',
    } });
    if (String(input).endsWith('/speak')) {
      posts++;
      if (backendRejects) return Response.json({ error: 'text_too_long', actual_chars: 615, max_chars: 600 }, { status: 413 });
      return new Response(Buffer.from('RIFF-fake-audio'), { headers: { 'content-type': 'audio/wav' } });
    }
    throw new Error('test forbids all other network calls');
  }) as typeof fetch;
  try {
    const settings = await import('../src/settings.js');
    await settings.load();
    const remote = await import('../src/audio/remoteTts.js');
    await remote.refresh();
    const tts = await import('../src/audio/tts.js');
    const { ttsCalls } = await import('../src/stats.js');
    await assert.rejects(tts.speak('x'.repeat(615), { kind: 'dj-speak' }), { name: 'SpeechRequestError' });
    assert.equal(posts, 0);
    assert.equal(ttsCalls[0].fellBack, false);
    assert.equal(ttsCalls[0].primary_error_code, 'text_too_long');
    backendRejects = true;
    await assert.rejects(tts.speak('valid length', { kind: 'dj-speak' }), { name: 'SpeechRequestError' });
    assert.equal(posts, 1);
    assert.equal(ttsCalls[0].http_status, 413);
    assert.equal(ttsCalls[0].fellBack, false);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
