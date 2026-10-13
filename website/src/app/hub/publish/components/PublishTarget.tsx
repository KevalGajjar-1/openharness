'use client';
import { useEffect, useState } from 'react';
import { myPublications } from '../publication';
import styles from '../../community.module.css';

type Props = { signedIn: boolean | null; updateId?: string; onChange: (updateId: string | undefined) => void };

/** Publish a new harness, or save this draft over one of yours: same address, likes and comments. */
export function PublishTarget({ signedIn, updateId, onChange }: Props) {
  const [mine, setMine] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void myPublications().then(list => { if (live) setMine(list); }, () => { /* Publishing new still works. */ });
    return () => { live = false; };
  }, [signedIn]);
  if (!mine.length && !updateId) return null;
  return <label className={styles.field}>Publish as<select value={updateId || ''} onChange={event => onChange(event.target.value || undefined)}>
    <option value="">A new harness</option>
    {mine.map(({ id, title }) => <option key={id} value={id}>Update “{title}”</option>)}
    {updateId && !mine.some(({ id }) => id === updateId) && <option value={updateId}>Update this harness</option>}
  </select></label>;
}
