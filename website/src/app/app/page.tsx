import { Smartphone } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APP_STORE_URL, GOOGLE_PLAY_URL, phoneStoreUrl } from "@/lib/phoneApp";
import cardStyles from "../pair/page.module.css";
import buttonStyles from "../desktop/page.module.css";

export const dynamic = "force-dynamic";

/**
 * `harness.autonomous.ai/app` — the download code for the phone app. A phone's camera opens it, and
 * the server sends it straight to its store by user agent: an iPhone to the App Store, an Android
 * phone to Google Play, each of which opens in the store app. Anything else — a computer, or an iPad
 * asking for the desktop site — gets both stores to choose from rather than a dead end.
 */
export default async function AppPage() {
  const store = phoneStoreUrl((await headers()).get("user-agent"));
  if (store) redirect(store);
  return (
    <main className={cardStyles.wrap}>
      <section className={cardStyles.card}>
        <div className={cardStyles.badge}>
          <Smartphone size={20} strokeWidth={2} />
        </div>
        <h1 className={cardStyles.title}>Get Harness on your phone</h1>
        <p className={cardStyles.sub}>
          Open <strong>harness.autonomous.ai/app</strong> on your iPhone or Android phone, or choose its store here.
        </p>
        <div className={buttonStyles.downloads}>
          <a className={buttonStyles.download} href={APP_STORE_URL}>App Store</a>
          <a className={buttonStyles.download} href={GOOGLE_PLAY_URL}>Google Play</a>
        </div>
      </section>
    </main>
  );
}
