import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type UndoTarget =
  | { kind: 'like'; songId: string; airingKey: string; listenerKey: string; likedAt: string; revision: string }
  | { kind: 'block'; songId: string; revision: string };
type Receipt = UndoTarget & { expiresAt: number };
const TTL = 30 * 60 * 1000;
const keyFor = (secret: string) => createHash('sha256').update('subwave-feedback-undo-v1\0'+secret).digest();

export function issueUndo(target: UndoTarget, secret = String(process.env.HOUSE_CONTROL_TOKEN || '').trim(), now = Date.now()) {
  if (!secret) return null;
  const expiresAt = now + TTL;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...target, expiresAt })), cipher.final()]);
  return { token: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url'), expiresAt };
}

export function readUndo(token: unknown, kind: UndoTarget['kind'], secret = String(process.env.HOUSE_CONTROL_TOKEN || '').trim(), now = Date.now()): Receipt | null {
  if (!secret || typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,1500}$/.test(token)) return null;
  try {
    const raw = Buffer.from(token,'base64url');
    if (raw.toString('base64url') !== token) return null;
    const decipher = createDecipheriv('aes-256-gcm',keyFor(secret),raw.subarray(0,12));
    decipher.setAuthTag(raw.subarray(12,28));
    const r = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString()) as Receipt;
    if (r.kind !== kind || !Number.isFinite(r.expiresAt) || r.expiresAt <= now || r.expiresAt > now+TTL || !/^[\w-]{1,64}$/.test(r.songId)) return null;
    if (kind === 'like' && (r.kind !== 'like' || !/^[a-f0-9]{24}$/.test(r.listenerKey) || typeof r.airingKey !== 'string' || !r.airingKey.startsWith(r.songId+'|') || typeof r.likedAt !== 'string' || !(r.revision === '' || /^[a-f0-9-]{36}$/.test(r.revision)))) return null;
    if (kind === 'block' && (r.kind !== 'block' || !/^[a-f0-9-]{36}$/.test(r.revision))) return null;
    return r;
  } catch { return null; }
}
