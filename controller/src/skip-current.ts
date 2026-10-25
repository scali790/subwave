type Dependencies = {
  getNowPlaying: () => Promise<{ subsonic_id?: string } | null>;
  commitBeforeSkip: () => Promise<{ pending: boolean; committed: boolean }>;
  skipTrack: () => Promise<unknown>;
};

// Same prepare/skip sequence as /dj/skip, restricted to the expected song.
export function createHouseSkip(deps: Dependencies) {
  let busy = false;
  async function status(songId: unknown) {
    if (typeof songId !== 'string' || !/^[\w-]{1,64}$/.test(songId))
      return { status: 400, body: { error: 'songId is required' } };
    if ((await deps.getNowPlaying())?.subsonic_id !== songId)
      return { status: 409, body: { error: 'That track just ended' } };
    return { status: 200, body: { ok: true } };
  }
  return {
    status,
    async skip(songId: unknown) {
      if (busy) return { status: 409, body: { error: 'Skip already in progress' } };
      busy = true;
      try {
        const before = await status(songId);
        if (before.status !== 200) return before;
        const prep = await deps.commitBeforeSkip();
        const after = await status(songId);
        if (after.status !== 200) return after;
        await deps.skipTrack(); // One write only; no retry on an uncertain result.
        return { status: 200, body: { ok: true, pending: prep.pending, committed: prep.committed } };
      } finally { busy = false; }
    },
  };
}
