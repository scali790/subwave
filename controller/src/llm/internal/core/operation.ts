import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface Operation { id: string; deadline: number; signal: AbortSignal; providerDeadline?: number }
const scope = new AsyncLocalStorage<Operation>();
export const currentOperation = () => scope.getStore();
export function operationSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const active = scope.getStore()?.signal;
  return active && signal ? AbortSignal.any([active, signal]) : active ?? signal ?? undefined;
}

export function providerDeadlineError() {
  return Object.assign(new Error('LLM provider phase exceeded its shared upstream budget'), { name: 'LlmProviderDeadlineError' });
}

// An explicitly budgeted provider owns one phase: SDK retries, backoff, tool
// steps and format recovery all inherit this deadline. It never aborts the
// parent operation, so a configured backup can use the remaining total time.
export async function withProviderBudget<T>(ms: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (ms == null) return fn();
  const parent = currentOperation();
  if (!parent) return withLlmBudget(ms, () => withProviderBudget(ms, fn));
  if (parent.providerDeadline != null) return fn();
  const requestedDeadline = performance.now() + ms;
  const deadline = Math.min(parent.deadline, requestedDeadline);
  const controller = new AbortController();
  const signal = AbortSignal.any([parent.signal, controller.signal]);
  // When the outer deadline wins, let its signal own the error. A second timer
  // for the same instant can fire first after millisecond rounding and wrongly
  // classify total exhaustion as a provider failure eligible for failover.
  const timer = requestedDeadline < parent.deadline
    ? setTimeout(() => controller.abort(providerDeadlineError()), Math.max(0, deadline - performance.now())) : undefined;
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await scope.run({ ...parent, providerDeadline: deadline, signal }, () => Promise.race([fn(), aborted]));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
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
      return await scope.run({ ...currentOperation()!, signal: combinedSignal }, () => Promise.race([fn(), aborted]));
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
