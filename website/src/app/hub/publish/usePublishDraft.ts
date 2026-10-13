'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readDraft, saveDraft, type HubDraft } from '@/lib/community/drafts';
import { communityCategories, communityEngines } from '@/lib/community/contract';
import { arrivedEnglish, noEnglish, type EnglishState } from '@/lib/community/translation';
import type { HarnessSnapshot } from '@/lib/community/types';
import { editDraft } from './publication';

/**
 * `originalOutput` is the fork's output as it arrived: kept here to compare against, never published.
 * `english` is where the draft stands with its translation, never published either.
 * `updateId` is your publication this draft is saved over, instead of publishing a new one.
 */
export type PublishDraft = Omit<HarnessSnapshot, 'harnessName' | 'credits'> & { contextNote: string; originalOutput?: string; english: EnglishState; updateId?: string };

const uuid = /^[a-f0-9-]{36}$/;

const fresh: PublishDraft = { title: '', description: '', category: 'Apps', engine: 'Codex', files: [], viewerPath: 'preview.html', conversation: [{ role: 'user', text: '' }], contextNote: '', english: noEnglish };

/** A handed-off or imported bundle, kept within what the form can show and the Hub accepts. */
function fromBundle(bundle: HubDraft): PublishDraft {
  return {
    title: String(bundle.title || '').slice(0, 100), description: String(bundle.description || '').slice(0, 300),
    category: communityCategories.includes(bundle.category || '') ? bundle.category! : 'Apps',
    engine: communityEngines.includes(bundle.engine || '') ? bundle.engine! : 'Codex',
    harnessId: bundle.harnessId, files: bundle.files || [], viewerPath: bundle.viewerPath || 'preview.html',
    conversation: bundle.conversation?.length ? bundle.conversation : fresh.conversation,
    forkedFrom: bundle.forkedFrom, cover: bundle.cover, contextNote: bundle.contextNote || '', originalOutput: bundle.originalOutput,
    english: arrivedEnglish(bundle.english),
    updateId: bundle.updateId && uuid.test(bundle.updateId) ? bundle.updateId : undefined,
  };
}

/**
 * The publish form's draft, kept in this browser under `?draft=<id>` so a reload or a sign-in keeps
 * it. `publicationId` makes a retried Publish return the same publication instead of a second one.
 */
export function usePublishDraft() {
  const [draft, setDraft] = useState(fresh), [ready, setReady] = useState(false), [saveError, setSaveError] = useState(''), [loadError, setLoadError] = useState('');
  const draftId = useRef<string | null>(null), publicationId = useRef<string | null>(null), submitting = useRef(false);
  const update = useCallback((patch: Partial<PublishDraft>) => setDraft(value => ({ ...value, ...patch })), []);
  const applyBundle = useCallback((bundle: HubDraft) => {
    setDraft(fromBundle(bundle));
    publicationId.current = bundle.clientId || crypto.randomUUID();
  }, []);

  useEffect(() => {
    let disposed = false;
    const params = new URLSearchParams(window.location.search), query = params.get('draft'), edit = params.get('edit');
    const id = query && uuid.test(query) ? query : crypto.randomUUID(), editId = edit && uuid.test(edit) ? edit : null;
    draftId.current = id; publicationId.current = crypto.randomUUID();
    if (!query) window.history.replaceState(null, '', `/hub/publish?draft=${id}${editId ? `&edit=${editId}` : ''}`);
    // A saved draft wins; `?edit=<id>` otherwise opens that publication as it is now.
    void readDraft(id).catch(() => undefined).then(async saved => {
      if (disposed) return;
      if (saved) return applyBundle(saved);
      if (!editId) return;
      try { const opened = await editDraft(editId); if (!disposed) setDraft(opened); }
      catch (e) { if (!disposed) setLoadError(e instanceof Error ? e.message : 'This harness could not be opened for editing.'); }
    }).finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [applyBundle]);

  useEffect(() => {
    if (!ready || !draftId.current || submitting.current) return;
    const id = draftId.current;
    const timer = setTimeout(() => {
      if (submitting.current) return;
      void saveDraft(id, { version: 1, ...draft, clientId: publicationId.current || undefined }).then(() => setSaveError(''), () => setSaveError('Your browser could not save this draft. Keep this tab open until you publish.'));
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, draft]);

  /** Sends the publication once at a time with this draft's id, then forgets the draft. */
  const publishOnce = useCallback(async (send: (clientId: string | undefined) => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await send(publicationId.current || undefined);
      if (draftId.current) await saveDraft(draftId.current, null).catch(() => {});
    } finally { submitting.current = false; }
  }, []);
  return { draft, update, applyBundle, saveError, loadError, publishOnce };
}
