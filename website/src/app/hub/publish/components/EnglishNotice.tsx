import type { EnglishState } from '@/lib/community/translation';
import styles from '../../community.module.css';

type Props = { english: EnglishState; signedIn: boolean | null; showOriginal?: () => void; useEnglish?: () => void; retry?: () => void };

/** Where the draft's English stands, with the one action that fits. */
export function EnglishNotice({ english, signedIn, showOriginal, useEnglish, retry }: Props) {
  if (english.status === 'pending') return signedIn ? <p className={styles.notice} role="status">Translating your title, description and conversation into English…</p> : null;
  if (english.status === 'translated') return <p className={styles.notice} role="status">Translated into English for the Hub. Review it below.<button type="button" onClick={showOriginal}>Show original</button></p>;
  if (english.status === 'original') return <p className={styles.notice} role="status">Showing your original words.<button type="button" onClick={useEnglish}>Use English</button></p>;
  if (english.status === 'failed') return <p className={styles.notice} role="status">Could not translate into English. {english.message}<button type="button" onClick={retry}>Try again</button></p>;
  return null;
}
