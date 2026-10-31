// Independent of runtime imports: the same coordinator is exercised with a fake
// station clock in regression tests. Never expose old audio before preparation.
export interface IdleProgramme {
  pausedAt: number;
  programmeKey: string;
}

export const FRESH_RESUME_AFTER_MS = 30 * 60_000;

// Repeating the same generation is safe even if the mixer executed the command
// but its first reply was lost. A restart forgets the generation and is refused.
export async function acknowledgeFreshResume(generation: string, send: (command: string) => Promise<string>): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(generation)) throw new Error('invalid programme generation');
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await send(`idle_resume_fresh ${generation}`)).trim() !== 'OK') throw new Error('fresh programme release not acknowledged');
      return;
    } catch (err) { failure = err; }
  }
  throw failure;
}

export function needsFreshProgramme(paused: IdleProgramme | null, now: number, programmeKey: string): boolean {
  return !paused || !Number.isFinite(paused.pausedAt) || now < paused.pausedAt
    || now - paused.pausedAt >= FRESH_RESUME_AFTER_MS || paused.programmeKey !== programmeKey;
}

export async function resumeProgramme(
  paused: IdleProgramme | null,
  deps: {
    clock: () => IdleProgramme;
    prepare: () => Promise<void>;
    release: (fresh: boolean) => Promise<void>;
  },
): Promise<boolean> {
  const at = deps.clock();
  const fresh = needsFreshProgramme(paused, at.pausedAt, at.programmeKey);
  if (fresh) {
    await deps.prepare();
    // Library I/O can cross another boundary. Retry with fresh context instead
    // of letting a successfully prepared, now-obsolete programme reach the air.
    if (deps.clock().programmeKey !== at.programmeKey) throw new Error('programme changed during idle preparation');
  }
  await deps.release(fresh);
  return fresh;
}
