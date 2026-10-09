import { operationSignal } from './operation.js';

// Only Ollama has a local model catalogue contract. Hosted backups retain
// their existing transport behavior. Cache keys include endpoint AND model.
export class FallbackAvailability {
  private entries = new Map<string, { until: number; ready: boolean; pending?: Promise<boolean> }>();
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now = () => performance.now(), private readonly cooldownMs = 60_000,
    private readonly healthyMs = 15_000, private readonly timeoutMs = 3000) {}

  private key(cfg: any): string { return `${String(cfg.ollamaUrl || '').replace(/\/$/, '')}|${cfg.model}`; }

  failed(cfg: any): void {
    if (cfg.provider !== 'ollama') return;
    this.entries.set(this.key(cfg), { ready: false, until: this.now() + this.cooldownMs });
  }

  async ready(cfg: any, resolvedUrl: string): Promise<boolean> {
    operationSignal()?.throwIfAborted();
    if (cfg.provider !== 'ollama') return true;
    const key = this.key({ ...cfg, ollamaUrl: resolvedUrl });
    const old = this.entries.get(key);
    if (old && old.until > this.now()) return old.ready;
    // A caller's deadline must not cancel another caller's shared probe. Each
    // probe has its own short limit; waiting still respects the outer deadline.
    let probe = old?.pending;
    if (!probe) {
      probe = this.probe(resolvedUrl, cfg.model).then(ready => {
        // A newer failed generation must win over an older in-flight probe.
        if (this.entries.get(key)?.pending === probe) {
          this.entries.set(key, { ready, until: this.now() + (ready ? this.healthyMs : this.cooldownMs) });
        }
        return ready;
      });
      this.entries.set(key, { ready: false, until: 0, pending: probe });
      if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
    }
    const ready = await probe;
    operationSignal()?.throwIfAborted();
    return this.entries.get(key)?.ready ?? ready;
  }

  private async probe(base: string, model: string): Promise<boolean> {
    try {
      const response = await this.fetcher(`${base.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return false;
      const body = await response.json() as any;
      const canonical = (s: string) => s.includes(':') ? s : `${s}:latest`;
      return Array.isArray(body.models) && body.models.some((m: any) => typeof m.name === 'string' && canonical(m.name) === canonical(model));
    } catch { return false; }
  }
}

export const fallbackAvailability = new FallbackAvailability();
