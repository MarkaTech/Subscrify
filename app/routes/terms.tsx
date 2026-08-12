import type { MetaFunction } from "react-router";
import source from "../legal/terms.md?raw";
import { renderMarkdown } from "../lib/legal/markdown";
import styles from "../styles/legal.module.css";

/**
 * Merchant terms of service and the Data Processing Addendum, at a stable
 * public URL. See privacy.tsx for why these are served by the app itself.
 *
 * The DPA is the answer to "do you have privacy and data protection
 * agreements with your merchants?" — a merchant needs to be able to read it
 * before installing, and to link their own compliance team to it afterwards.
 */
export const meta: MetaFunction = () => [
  { title: "Terms of Service & DPA — Marka Subscrify" },
  {
    name: "description",
    content:
      "Merchant terms of service and Data Processing Addendum for Marka Subscrify, the Shopify subscriptions app by Marka Modern Retail Private Limited.",
  },
];

export default function Terms() {
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
