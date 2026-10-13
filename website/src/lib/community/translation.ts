import { communityRequest } from './client';
import type { HarnessSnapshot } from './types';

/** The words of a publication, as the Hub translates them. */
export type DraftTexts = Pick<HarnessSnapshot, 'title' | 'description' | 'conversation'>;

/**
 * Where a draft stands with English. `pending` is how a draft arrives from Desktop or a bundle;
 * `translated` and `original` each keep the other version, so the author can switch back and forth.
 */
export type EnglishState =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'translated'; original: DraftTexts }
  | { status: 'original'; english: DraftTexts };

export const noEnglish: EnglishState = { status: 'none' };
const statuses = new Set<string>(['none', 'pending', 'failed', 'translated', 'original']);

/** Only the words: a turn carries nothing else the Hub would refuse. */
export const textsOf = ({ title, description, conversation }: DraftTexts): DraftTexts =>
  ({ title, description, conversation: conversation.map(({ role, text }) => ({ role, text })) });

/** Words worth translating: tool output is never translated. */
export const hasWords = (texts: DraftTexts) =>
  !!(texts.title.trim() || texts.description.trim() || texts.conversation.some(turn => turn.role !== 'tool' && turn.text.trim()));

/** A saved draft keeps where it stood; one that just arrived has not been translated yet. */
export function arrivedEnglish(value: unknown): EnglishState {
  const status = (value as { status?: unknown } | null)?.status;
  return typeof status === 'string' && statuses.has(status) ? value as EnglishState : { status: 'pending' };
}

export const requestEnglish = (texts: DraftTexts) =>
  communityRequest<DraftTexts & { translated: boolean }>('translate', { method: 'POST', body: texts });
