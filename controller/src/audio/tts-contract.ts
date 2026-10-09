// Backend limits are optional for generic Remote TTS; never invent a limit for
// a server which does not advertise this versioned contract.
export interface SpeechConstraints {
  schema_version: 1;
  max_text_chars: number;
  text_normalization: 'python-whitespace-codepoints-v1';
  voices?: string[];
  default_voice?: string;
}

export function readSpeechConstraints(value: any): SpeechConstraints | null {
  if (value?.schema_version !== 1 || value?.text_normalization !== 'python-whitespace-codepoints-v1'
      || !Number.isInteger(value.max_text_chars) || value.max_text_chars < 1 || value.max_text_chars > 100_000) return null;
  return { schema_version: 1, max_text_chars: value.max_text_chars,
    text_normalization: value.text_normalization,
    voices: Array.isArray(value.voices) ? value.voices.filter((v: unknown) => typeof v === 'string') : undefined,
    default_voice: typeof value.default_voice === 'string' ? value.default_voice : undefined };
}

// Python str.split()/len() contract. JS \s differs for U+0085, U+001C–1F
// and FEFF; JS .length counts UTF-16 units instead of Unicode codepoints.
export function contractText(text: string): string {
  return text.split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean).join(' ');
}

export class SpeechRequestError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, readonly httpStatus = 422,
    readonly actualChars?: number, readonly maxChars?: number) {
    super(code === 'text_too_long'
      ? `Speech text has ${actualChars} characters; this voice service accepts at most ${maxChars}. Please shorten the announcement.`
      : `Speech request rejected (${code}). Please check the text and voice.`);
    this.name = 'SpeechRequestError';
  }
}

export function validateSpeech(text: string, constraints: SpeechConstraints | null, voice?: string): void {
  if (!constraints) return;
  const actual = [...contractText(text)].length;
  if (!actual) throw new SpeechRequestError('text_required', 400);
  if (actual > constraints.max_text_chars) throw new SpeechRequestError('text_too_long', 422, actual, constraints.max_text_chars);
  if (voice && constraints.voices && !constraints.voices.includes(voice)) throw new SpeechRequestError('unknown_voice', 422);
}

export function speechFailure(err: any): Record<string, unknown> {
  return { primary_error_code: err?.code ?? err?.name ?? 'render_failed',
    ...(typeof err?.httpStatus === 'number' ? { http_status: err.httpStatus } : {}),
    ...(typeof err?.actualChars === 'number' ? { actual_chars: err.actualChars } : {}),
    ...(typeof err?.maxChars === 'number' ? { max_chars: err.maxChars } : {}) };
}
