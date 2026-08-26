# Merchant Terms of Service and Data Processing Addendum — Marka Subscrify

**Last updated: 26 August 2026**

These terms govern your use of the Marka Subscrify Shopify app, published by **MARKA MODERN RETAIL PRIVATE LIMITED** ("we", "us"), registered in India, trading as House of Marka, at Basement, Plot No. 39, Sector 27, Gurugram, Haryana 122001, India. Installing the app on your Shopify store means you accept them. If you're accepting on behalf of a company, you confirm you're authorised to bind it.

---

# Part A — Terms of Service

## 1. What the app does

Marka Subscrify lets you sell subscription products on Shopify. You create a subscription program, attach it to products, and the app schedules and executes the recurring charges through Shopify's own subscription and billing systems, retrying a renewal when a payment fails.

The app is an interface to Shopify's subscription infrastructure. It does not process payments itself and does not hold funds.

## 2. Your Shopify account

You need an active Shopify store, and your use of Shopify remains governed by your agreement with Shopify. If your Shopify account is suspended or closed, or the permissions the app depends on are withdrawn, the app will stop working — including stopping renewals.

## 3. Your responsibilities

You decide what you sell, on what schedule, at what price, and with what refund and cancellation terms. You are responsible for making those terms clear to your customers before they subscribe, for honouring them, and for complying with the recurring-payment and consumer-protection rules that apply where your customers live. Several jurisdictions impose specific requirements on subscriptions — pre-renewal notice, easy cancellation, clear disclosure of price and frequency — and meeting them is your obligation, not ours.

You are responsible for the accuracy of the products, prices and schedules you configure. The app charges what your configuration says to charge.

## 4. Billing your customers

The app is built so that a subscription is never charged twice for the same billing cycle. Every charge carries an idempotency key derived from the subscription and the cycle it belongs to, and that key is enforced independently at three layers: our own database, the message queue that carries the instruction, and Shopify's billing API. Any one of the three stopping a duplicate is sufficient.

We take this seriously, but you should still reconcile your own payouts. If you believe a customer has been charged incorrectly, tell us and we'll investigate promptly; refunds to your customers are issued by you through Shopify.

## 5. Fees

The app is currently free to use. If we introduce charges we will give at least 30 days' notice in the app and by email, and you may uninstall before they take effect. Any future charges would be made through Shopify's billing system and appear on your Shopify invoice.

## 6. Availability and support

We aim to keep the app available continuously and to execute renewals on schedule, but we don't offer a contractual uptime guarantee. Scheduled maintenance will be announced where practical. Support is available by email at support@houseofmarka.com; we aim to respond within 24 hours on business days.

## 7. Acceptable use

Don't use the app to sell anything unlawful where your customers are, to charge people who haven't agreed to a subscription, to circumvent Shopify's platform rules, or to attempt to access another merchant's data. Don't attempt to disrupt, reverse-engineer or overload the service.

## 8. Intellectual property

We keep all rights in the app. You keep all rights in your store data, products and customer relationships. Nothing here transfers ownership of either.

## 9. Termination

You can uninstall the app at any time from your Shopify admin. Doing so stops future renewals from being processed — plan around that before you uninstall, because your subscribers' contracts will no longer be billed by us. We may suspend or terminate access if you materially breach these terms, or if we discontinue the app, in which case we will give reasonable notice where we can.

On uninstall, your data is deleted as described in Part B, section 8.

## 10. Warranties and liability

The app is provided "as is" and "as available", without warranties of any kind except those that cannot lawfully be excluded.

To the maximum extent permitted by law, we are not liable for indirect, incidental, special or consequential losses, or for lost profits, revenue, goodwill or data. Our total aggregate liability arising out of or relating to the app is limited to the greater of the fees you paid us in the twelve months before the event giving rise to the claim, or INR 10,000.

Nothing in this section limits liability for fraud, wilful misconduct, death or personal injury caused by negligence, or anything else that cannot be limited under applicable law.

## 11. Indemnity

You will indemnify us against third-party claims arising from your products, your subscription terms, or your breach of these terms or of applicable law.

## 12. Changes

We may update these terms. Material changes take effect 30 days after we notify you in the app or by email; continuing to use the app after that means you accept them. If you don't, uninstall before they take effect.

## 13. Governing law

These terms are governed by the laws of India, and the courts at Gurugram, Haryana have exclusive jurisdiction, except where mandatory consumer or data protection law in your own country gives you the right to bring proceedings there.

---

# Part B — Data Processing Addendum

This Addendum forms part of the Terms of Service and applies where we process personal data on your behalf. Where it conflicts with Part A on data protection matters, this Addendum governs.

## 1. Roles

You are the **controller** of your customers' personal data. We are your **processor**, acting only on your documented instructions. Installing the app and configuring it constitutes your instruction to process as described here. We are an independent controller only in respect of your own account and staff contact data, which is covered by our Privacy Policy.

## 2. Subject matter and duration

We process personal data for as long as the app is installed on your store, plus the retention periods in section 8. The purpose is providing subscription management and recurring billing.

## 3. What is processed

**Categories of data subject:** your customers who hold a subscription, and your staff who use the app.

**Categories of personal data actually held by us:** for your staff, the Shopify user id, name, email address and locale carried in a Shopify session. For your customers, **none is stored**. The app reads a subscriber's name and email live from Shopify for on-screen display and does not write them to its database; it stores only the subscription contract identifier, billing cycle, charge status and error codes, alongside your store domain.

**No special-category data** is requested or knowingly processed, and no payment card data is ever received by us — charges are executed inside Shopify.

## 4. Our obligations

We will process personal data only on your instructions and for the purposes above; ensure that anyone authorised to access it is bound by confidentiality; implement the technical and organisational measures described in section 6; and assist you, taking into account the nature of the processing, in responding to data subject requests and in meeting your own security, breach notification and impact assessment obligations.

If we believe an instruction from you infringes applicable data protection law, we will tell you.

## 5. Sub-processors

You give general authorisation for the sub-processors below. We remain liable for their performance.

**Microsoft Corporation (Microsoft Azure)** — hosting of the application, database, message queue and logs, in the Central India region.

We will give you at least 30 days' notice before adding or replacing a sub-processor, and you may object on reasonable data protection grounds; if we can't resolve the objection, you may terminate by uninstalling without penalty.

Shopify is not our sub-processor — it is the platform and the source of the data, and your relationship with Shopify is direct.

## 6. Security measures

Encryption of all data in transit (TLS) and at rest (AES-256, including backups). A database that is not exposed to the public internet and requires TLS for every connection. Credentials held in the platform secret store, never in source code. Every query in the application is scoped to a single store, so data cannot cross between merchants. Access to production is restricted to authorised personnel on a least-privilege basis. Access by staff to any page displaying customer details is logged, recording who, when, which subscription and which fields — but never the field values.

We review these measures periodically and may update them, provided the level of protection is not reduced.

## 7. Personal data breaches

We will notify you without undue delay, and in any case within **48 hours**, of becoming aware of a personal data breach affecting your data. The notification will describe what happened, the categories and approximate volume of data and data subjects affected, the likely consequences, and the measures taken. We will provide the information you reasonably need to meet your own 72-hour regulatory notification deadline. Our written incident response procedure is available to you on request.

## 8. Deletion and return

When you uninstall the app, your session data is deleted immediately. Shopify then sends a shop erasure request approximately 48 hours later, on receipt of which we delete your store's billing attempt history in full. On written request before then, we will delete or return your data sooner. Backups age out on Azure's standard backup cycle. We retain nothing beyond what applicable law requires us to keep.

## 9. Audits

We will make available the information reasonably necessary to demonstrate compliance with this Addendum, and will respond to security questionnaires. Given the size of our operation, we do not currently hold a third-party certification such as SOC 2 or ISO 27001, and we don't claim one. On-site audits may be arranged where a supervisory authority requires them, at your cost and on reasonable notice.

## 10. International transfers

Data is processed in India. For transfers of EEA or UK personal data, the parties incorporate the European Commission's Standard Contractual Clauses (Module Two, controller to processor) and, for UK data, the UK International Data Transfer Addendum, with you as data exporter and us as data importer. In case of conflict, those clauses prevail over this Addendum. The technical measures in section 6 constitute the supplementary measures.

## 11. Contact

Data protection queries: support@houseofmarka.com, marked "Attention: Grievance Officer".

---

**Note before publishing:** the bracketed items above are the facts only you can supply — registered address, pricing, support email and response time, liability floor, jurisdiction city, and the grievance contact. Nothing else needs changing. This document is not legal advice; for a subscription-billing app handling EEA customers, having a lawyer read it once is money well spent.
