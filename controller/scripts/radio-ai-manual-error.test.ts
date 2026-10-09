import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('manual announcement surfaces render rejection; automated announcement stays fail-silent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-ai-announce-'));
  process.env.STATE_DIR = dir;
  try {
    const { queue } = await import('../src/broadcast/queue.js');
    const { SpeechRequestError } = await import('../src/audio/tts-contract.js');
    const error = new SpeechRequestError('text_too_long', 422, 615, 600);
    const fake = { _speak: async () => { throw error; }, log: () => {} };
    await assert.rejects(queue.announce.call(fake, 'Text', 'dj-speak', { throwOnError: true }), error);
    const outcome = await queue.announce.call(fake, 'Text', 'announcement');
    assert.equal(outcome.accepted, false);
    assert.equal(await outcome.completed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
