import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface Operation { id: string; deadline: number; signal: AbortSignal }
const scope = new AsyncLocalStorage<Operation>();
export const currentOperation = () => scope.getStore();
export function operationSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const active = scope.getStore()?.signal;
  return active && signal ? AbortSignal.any([active, signal]) : active ?? signal ?? undefined;
}

// Scope a whole decision, including deterministic recovery. Only model calls
// race this signal: music selection/enqueue must finish and must not be orphaned.
export async function withLlmBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return fn();
  if (!Number.isFinite(ms) || ms <= 0) ms = 45_000;
  const controller = new AbortController();
  const error = Object.assign(new Error('LLM operation exceeded its total deadline'), { name: 'LlmDeadlineError' });
  const timer = setTimeout(() => controller.abort(error), ms);
  try {
    return await scope.run({ id: randomUUID(), deadline: performance.now() + ms, signal: controller.signal }, fn);
  } finally { clearTimeout(timer); }
}

export async function withinOperation<T>(ms: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withLlmBudget(ms, async () => {
    const combinedSignal = operationSignal(signal)!;
    let rejectAbort: () => void = () => {};
    try {
      combinedSignal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(combinedSignal.reason);
        combinedSignal.addEventListener('abort', rejectAbort, { once: true });
      });
      return await Promise.race([fn(), aborted]);
    } finally {
      combinedSignal.removeEventListener('abort', rejectAbort);
    }
  });
}

// Never retain response bodies, tokens, headers or provider-generated text here.
export function upstreamDiagnostic(error: any): Record<string, unknown> {
  const e = error?.lastError ?? error;
  const out: Record<string, unknown> = {};
  const status = e?.statusCode ?? e?.cause?.statusCode;
  if (Number.isInteger(status)) out.httpStatus = status;
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === 'string' && /^[A-Z_0-9]{1,40}$/.test(code)) out.transportCode = code;
  try {
    const body = JSON.parse(e?.responseBody ?? 'null');
    const detail = body?.last_error;
    if (typeof detail?.error === 'string' && /^upstream_[a-z_]{1,50}$/.test(detail.error)) out.upstreamCode = detail.error;
    if (Number.isInteger(detail?.status_code)) out.upstreamStatus = detail.status_code;
    if (Number.isFinite(body?.elapsed_seconds)) out.upstreamSeconds = body.elapsed_seconds;
    if (Number.isInteger(body?.attempted_keys)) out.upstreamAttempts = body.attempted_keys;
  } catch { /* non-JSON provider error */ }
  return out;
}
