'use client';
import { useEffect, useRef } from 'react';
import { hasWords, noEnglish, requestEnglish, textsOf } from '@/lib/community/translation';
import type { PublishDraft } from './usePublishDraft';

type Update = (patch: Partial<PublishDraft>) => void;

/**
 * Translates a draft that arrived from Desktop or a bundle into English once the author is signed in,
 * keeping the original to switch back to. Edits made while it translates win: the answer is dropped.
 */
export function useEnglishDraft(draft: PublishDraft, update: Update, signedIn: boolean | null) {
  const texts = textsOf(draft), key = JSON.stringify(texts);
  const latest = useRef(key), asking = useRef(false);
  const pending = draft.english.status === 'pending';

  useEffect(() => { latest.current = key; }, [key]);

  useEffect(() => {
    if (!pending || !signedIn || asking.current) return;
    const asked = JSON.parse(key) as typeof texts;
    if (!hasWords(asked)) { update({ english: noEnglish }); return; }
    asking.current = true;
    requestEnglish(asked).then(({ translated, ...english }) => {
      if (!translated || latest.current !== key) return update({ english: noEnglish });
      update({ ...textsOf(english), english: { status: 'translated', original: asked } });
    }, (error: unknown) => {
      update({ english: { status: 'failed', message: error instanceof Error ? error.message : 'The translation failed.' } });
    }).finally(() => { asking.current = false; });
  }, [pending, signedIn, key, update]);

  const english = draft.english;
  return {
    showOriginal: english.status === 'translated' ? () => update({ ...english.original, english: { status: 'original', english: texts } }) : undefined,
    useEnglish: english.status === 'original' ? () => update({ ...english.english, english: { status: 'translated', original: texts } }) : undefined,
    retry: english.status === 'failed' ? () => update({ english: { status: 'pending' } }) : undefined,
  };
}
