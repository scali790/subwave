// Station-wide voice switch (`settings.tts.enabled`). Call sites ask; this
// module answers, so the policy lives in one place.
//
// The gate sits BEFORE generation, not at speak(), or the LLM writes every
// script and throws it away. Picks, listener requests and jingles keep running
// with voice off; only the spoken line is dropped. Manual /dj/segment triggers
// bypass this entirely. Read live, so the toggle applies on the next tick.

import * as settings from '../settings.js';

// Absent/non-boolean reads as ON, so an upgrade changes nothing.
export function voiceEnabled(): boolean {
  return settings.get()?.tts?.enabled !== false;
}

// A show tagged `music-only` is an editorial quiet window. Keep the station-wide
// voice switch ON so manual operator speech remains available, but refuse every
// autonomous speech path before LLM/TTS generation while such a show is active.
export function musicOnlyShowActive(date: Date = new Date()): boolean {
  const show = settings.resolveActiveShow(date);
  return Array.isArray(show?.tags) && show.tags.includes('music-only');
}

// May an AUTONOMOUS talk moment start? Manual runners must NOT call this.
export function autoVoiceAllowed(date: Date = new Date()): boolean {
  return voiceEnabled() && !musicOnlyShowActive(date);
}

export function voiceStatus() {
  return { enabled: voiceEnabled() };
}
