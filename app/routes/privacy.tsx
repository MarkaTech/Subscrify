import type { HeadersFunction, MetaFunction } from "react-router";
import source from "../legal/privacy.md?raw";
import { renderMarkdown } from "../lib/legal/markdown";
import { publicPageHeaders } from "../lib/http/security-headers";
import styles from "../styles/legal.module.css";

export const headers: HeadersFunction = () => publicPageHeaders();

/**
 * The published privacy policy, at a stable public URL.
 *
 * The App Store listing requires a privacy policy link, and the
 * protected-customer-data review asks whether merchants are told what data is
 * processed and why — both need a URL that exists and keeps existing. Serving
 * it from the app itself means it moves with the app and can never 404
 * because a separate marketing site was retired.
 *
 * The document lives in app/legal/privacy.md and is bundled at build time.
 * Same file that ships to merchants and reviewers, so the published page and
 * the sent copy cannot drift.
 */
export const meta: MetaFunction = () => [
  { title: "Privacy Policy — Marka Subscrify" },
  {
    name: "description",
    content:
      "How Marka Subscrify handles merchant and customer data. The app stores no customer personal data: subscriber names and emails are read live from Shopify for display and never written to its database.",
  },
];

export default function Privacy() {
  return (
    <div className={styles.page}>
      <main className={styles.doc}>
        <a className={styles.back} href="/">
          &larr; Marka Subscrify
        </a>
        {renderMarkdown(source)}
      </main>
    </div>
  );
}
