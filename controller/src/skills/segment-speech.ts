import { SpeechRequestError } from '../audio/tts-contract.js';
import { normalizeForDisplay } from '../audio/speech-text.js';

// One logical shortening attempt, never a substring cut or a rescue voice.
// Validation must use the dispatcher's actual pronunciation/Unicode contract.
export async function prepareSegmentSpeech(
  text: string,
  validate: (text: string) => void,
  shorten: (text: string, maxChars: number) => Promise<string>,
): Promise<{ text: string; shortened: boolean }> {
  const original = normalizeForDisplay(text);
  if (!original) throw new Error('segment produced no spoken text');
  try {
    validate(original);
    return { text: original, shortened: false };
  } catch (err) {
    if (!(err instanceof SpeechRequestError) || err.code !== 'text_too_long' || !err.maxChars) throw err;
    const revised = normalizeForDisplay(await shorten(original, err.maxChars));
    if (!revised || !/[.!?…][\u0022'”’»)]*$/.test(revised)) {
      throw new Error('shortened segment must end with a complete sentence');
    }
    validate(revised);
    return { text: revised, shortened: true };
  }
}
