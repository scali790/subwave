// Opt-in contract with the internal gateway. The existing header now bounds the
// complete provider phase, not a fresh allowance for every SDK HTTP attempt.
import { currentOperation, providerDeadlineError } from '../core/operation.js';

export const UPSTREAM_BUDGET_HEADER = 'x-homelab-upstream-budget-seconds';
const GATEWAY_MIN_SECONDS = 5;

export function configuredUpstreamBudgetMs(cfg: any): number | undefined {
  if (cfg?.provider !== 'openai-compatible' && cfg?.provider !== 'locca') return undefined;
  const pair = Object.entries(cfg?.headers || {}).find(([name]) => name.toLowerCase() === UPSTREAM_BUDGET_HEADER);
  const seconds = Number(pair?.[1]);
  return Number.isFinite(seconds) && seconds >= GATEWAY_MIN_SECONDS ? seconds * 1000 : undefined;
}

export function remainingUpstreamBudget(headers: Headers): void {
  if (!headers.has(UPSTREAM_BUDGET_HEADER)) return;
  const phase = currentOperation();
  if (phase?.providerDeadline == null) return;
  const configured = Number(headers.get(UPSTREAM_BUDGET_HEADER));
  if (!Number.isFinite(configured) || configured < GATEWAY_MIN_SECONDS) return;
  const seconds = Math.min(configured, (Math.min(phase.providerDeadline, phase.deadline) - performance.now()) / 1000);
  // The gateway clamps below five seconds upward. Do not start another request
  // whose minimum server budget would extend past this phase or the operation.
  if (seconds < GATEWAY_MIN_SECONDS) throw providerDeadlineError();
  headers.set(UPSTREAM_BUDGET_HEADER, String(Math.floor(seconds * 1000) / 1000));
}
