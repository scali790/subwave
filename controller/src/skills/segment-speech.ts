import { normalizeForDisplay } from '../audio/speech-text.js';

// Do not rewrite or cut generated copy: the NIM semantic qualification failed.
// Validation uses the dispatcher's final pronunciation/Unicode contract.
export function prepareSegmentSpeech(
  text: string,
  validate: (text: string) => void,
): string {
  const original = normalizeForDisplay(text);
  if (!original) throw new Error('segment produced no spoken text');
  validate(original);
  return original;
}
