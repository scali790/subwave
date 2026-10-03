import { timingSafeEqual } from 'node:crypto';

export type HouseControlAuth = 'ok' | 'unconfigured' | 'unauthorized';

export interface CurrentTrackSnapshot {
  songId: string;
  title: string;
  artist: string;
  album: string;
}

export interface NeverPlayDeps {
  getNowPlaying: () => Promise<any>;
  listBlocks: () => Array<{ type: string; id: string }>;
  addTrackBlock: (input: {
    type: 'track';
    id: string;
    name: string | null;
    artist: string | null;
    album: string | null;
  }) => Promise<any | null>;
  purgeBlocked: () => number;
  refreshAutoPlaylist: () => Promise<unknown>;
  log: (level: string, message: string) => void;
}

export interface HouseControlResult {
  status: number;
  body: Record<string, unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function authorizeHouseControl(
  authorization: string | undefined,
  configuredToken = String(process.env.HOUSE_CONTROL_TOKEN || '').trim(),
): HouseControlAuth {
  if (!configuredToken) return 'unconfigured';
  const header = String(authorization || '');
  if (!header.startsWith('Bearer ')) return 'unauthorized';
  const supplied = header.slice(7).trim();
  return supplied && safeEqual(supplied, configuredToken) ? 'ok' : 'unauthorized';
}

function validSongId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[\w-]{1,64}$/.test(id) ? id : '';
}

async function currentTrack(deps: NeverPlayDeps): Promise<CurrentTrackSnapshot | null> {
  const np = await deps.getNowPlaying();
  const songId = validSongId(np?.subsonic_id);
  if (!songId) return null;
  return {
    songId,
    title: String(np?.title || '').trim(),
    artist: String(np?.artist || '').trim(),
    album: String(np?.album || '').trim(),
  };
}

function isExactTrackBlocked(deps: NeverPlayDeps, songId: string): boolean {
  return deps.listBlocks().some((entry) => entry?.type === 'track' && entry?.id === songId);
}

export async function getNeverPlayCurrent(
  requestedSongId: unknown,
  deps: NeverPlayDeps,
): Promise<HouseControlResult> {
  const requested = validSongId(requestedSongId);
  if (!requested) {
    return { status: 400, body: { error: 'songId is required' } };
  }

  const current = await currentTrack(deps);
  if (!current) {
    return { status: 409, body: { error: 'Nothing blockable on air right now' } };
  }
  if (requested !== current.songId) {
    return { status: 409, body: { error: 'That track just ended' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      blocked: isExactTrackBlocked(deps, current.songId),
      title: current.title,
      artist: current.artist,
    },
  };
}

export async function neverPlayCurrent(
  requestedSongId: unknown,
  deps: NeverPlayDeps,
): Promise<HouseControlResult> {
  const state = await getNeverPlayCurrent(requestedSongId, deps);
  if (state.status !== 200) return state;

  const requested = validSongId(requestedSongId);
  if (state.body.blocked === true) {
    return {
      status: 200,
      body: {
        ...state.body,
        alreadyBlocked: true,
      },
    };
  }

  const np = await deps.getNowPlaying();
  const current = validSongId(np?.subsonic_id);
  if (!current || current !== requested) {
    return { status: 409, body: { error: 'That track just ended' } };
  }

  const entry = await deps.addTrackBlock({
    type: 'track',
    id: requested,
    name: String(np?.title || '').trim() || null,
    artist: String(np?.artist || '').trim() || null,
    album: String(np?.album || '').trim() || null,
  });

  if (!entry) {
    return {
      status: 200,
      body: {
        ok: true,
        blocked: true,
        alreadyBlocked: true,
        title: String(np?.title || '').trim(),
        artist: String(np?.artist || '').trim(),
      },
    };
  }

  const purged = deps.purgeBlocked();
  deps.log(
    'blocked',
    `house-control: track "${entry.name ?? entry.id}"${entry.artist ? ` — ${entry.artist}` : ''} added to the never-play blocklist`,
  );
  deps.refreshAutoPlaylist().catch((err: any) =>
    deps.log('error', `house-control auto-playlist refresh failed: ${err?.message || err}`),
  );

  return {
    status: 201,
    body: {
      ok: true,
      blocked: true,
      alreadyBlocked: false,
      title: entry.name ?? '',
      artist: entry.artist ?? '',
      purged,
    },
  };
}
