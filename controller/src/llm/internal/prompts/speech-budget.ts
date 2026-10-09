import * as settings from '../../../settings.js';
import { constraints } from '../../../audio/remoteTts.js';
import { resolvePersonaVoiceSlot } from '../../../audio/persona-engine.js';

// Leave headroom for pronunciation corrections. This is guidance only; the
// dispatcher validates the actual final text against the advertised contract.
export function speechBudget(persona: unknown): string {
  const slot = resolvePersonaVoiceSlot((persona as { tts?: any } | null)?.tts, settings.get().tts);
  const contract = slot?.engine === 'remote' ? constraints() : null;
  if (!contract) return '';
  const target = Math.max(1, Math.floor(contract.max_text_chars * 5 / 6));
  return `\nKeep the complete spoken text within ${target} characters including spaces. Finish complete sentences; never emit a cut-off sentence.`;
}
