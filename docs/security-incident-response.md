# Security incident response procedure — Marka Subscrify

**Owner:** [NAME], MARKA MODERN RETAIL PRIVATE LIMITED
**Version 1.0 — 12 August 2026. Review: annually, or after any incident.**

This is an internal operating procedure, not a marketing document. It exists so that the person handling an incident at 2 a.m. — currently one person — does not have to invent a process while under pressure. It is short on purpose: a procedure nobody can follow is worse than none.

It also answers two questions Shopify's protected-customer-data review asks: whether a documented incident response policy exists, and what the data loss prevention strategy is.

## 1. What counts as an incident

Anything that plausibly compromises the confidentiality, integrity or availability of merchant or customer data, or the correctness of billing. Concretely:

Unauthorised access to the Azure subscription, the database, the container registry, the GitHub repository, or the Shopify Partner account. Leak or exposure of a credential — a Shopify API secret, the database password, an access token, a GitHub PAT. Data returned to the wrong merchant, or any failure of store scoping. A duplicate or incorrect charge to a subscriber. Loss or corruption of the database. Malicious code reaching production through a dependency or a commit. Extended unavailability that stops renewals from being billed.

A single failed login, a transient 500, or a dependency alert with no exploit path is not an incident. Note it, don't escalate it.

**Severity.** *High* — customer or merchant personal data was or may have been accessed by someone unauthorised, money moved incorrectly, or store scoping failed. *Medium* — a credential was exposed but there is no evidence of use, or data integrity is in question. *Low* — availability only, no data at risk.

## 2. Roles

One person holds all of these today; naming them separately matters because it forces the distinct questions to actually get asked.

**Incident lead** ([NAME], [PHONE], [EMAIL]) — decides severity, directs the response, and is the only person who declares an incident over.

**Communications** — notifies affected merchants and, where required, regulators.

**Technical response** — contains, investigates, and restores.

When a second person joins the company, split the incident lead from technical response first: the person fixing the problem should not also be the one deciding whether it needs reporting.

## 3. The first hour

**Record the clock.** Write down the time you became aware. Every regulatory deadline runs from that moment, and reconstructing it later is unconvincing.

**Start a log.** One file, appended to as you go, timestamps on every entry: what you observed, what you did, what you concluded. Do this even when it feels like overhead. It becomes the evidence of a diligent response and the input to the notification.

**Contain, without destroying evidence.** Preserve logs before you rotate anything — Azure Log Analytics holds the application, audit and access logs, and they are what will tell you the scope. Then, as applicable:

- Credential exposure: rotate the secret in Azure Container Apps and, for a Shopify secret, in the Partner Dashboard; revoke the old one; redeploy.
- Suspected unauthorised Azure access: reset the account password, revoke sessions, review the Azure Activity Log for what was touched.
- Compromised GitHub token: revoke it in developer settings, review recent commits and Actions runs for anything you did not author.
- Data integrity or wrong-merchant exposure: take the affected route out of service rather than leave it serving wrong data.
- Billing error: stop the scheduler before doing anything else, so the error cannot repeat while you investigate.

**Do not** delete logs, force-push over history, or "clean up" the environment before scope is established.

## 4. Assess the scope

Answer these before notifying anyone, and write the answers in the log.

Which stores are affected, and how many? Which categories of data — merchant staff details from sessions, billing records, or customer personal data? Was anything actually accessed, or only accessible? Over what window? Is it ongoing or stopped?

The two places to look are the Azure Log Analytics workspace — application logs, and the `AUDIT` lines recording who viewed which subscription and which fields — and the Azure Activity Log for infrastructure changes. The audit trail exists precisely so this question can be answered rather than guessed at.

The honest answer is sometimes "we cannot determine whether it was accessed." Say that, both in the log and to merchants, rather than implying a certainty you don't have.

## 5. Notify

**Merchants — within 48 hours of becoming aware**, as committed in the Data Processing Addendum. Tell them what happened, which of their data was involved, what the likely consequences are, what has been done, and what if anything they should do. Send it even if the news is "your store was in scope but we found no evidence of access."

**Regulators.** As a processor, our duty is to notify the merchant, who then decides on their own regulatory notification. Where we are a controller — for merchant staff account data — the GDPR's **72-hour** deadline to the relevant supervisory authority applies, and India's DPDP Act requires notification to the Data Protection Board and to affected individuals. Send the notification within the deadline even if the picture is still incomplete; supervisory authorities accept a first report followed by an update, and they do not accept lateness.

**Shopify** — for anything involving the app's access to store data or protected customer data, notify Shopify Partner support promptly. Discovering it independently is significantly worse for the app's standing than being told.

**Customers of a merchant** are notified by the merchant, not by us. We supply the facts they need.

Never notify anyone before containment, and never speculate about cause in a notification.

## 6. Restore and close

Restore from the Azure PostgreSQL automated backups using point-in-time restore if data was lost or corrupted. Verify the restored state before returning to service — in particular that billing attempt records are intact, since they are what prevents a double charge on the next run.

Confirm the vulnerability is closed, not merely quiet. Then declare the incident over, in the log, with a timestamp.

## 7. Afterwards

Within a week, write a short post-incident note: what happened, why it was possible, how it was found, what has changed so it cannot recur. Add a test if the cause was in code. Add a monitor if the cause was found by luck rather than by an alert — the fact that nothing alerted is itself a finding.

Keep incident logs for at least three years.

## 8. Preventive posture

This section is the standing answer to "what is your data loss prevention strategy."

**Against loss:** Azure Database for PostgreSQL Flexible Server takes automated encrypted backups with point-in-time restore. Source code and infrastructure definitions live in Git, so the environment is rebuildable from the repository. Restore is verified [RESTORE TEST CADENCE — annually is a reasonable commitment; a strategy nobody has tested is a hope].

**Against exfiltration:** the database is not reachable from the public internet and requires TLS. Credentials live in the platform secret store, never in source. Every query is scoped to a single store, so a single request cannot return another merchant's data. The app stores no customer personal data at all, which removes the bulk-export risk at its root rather than trying to detect it. Access to pages that display subscriber details is logged with actor, store, subscription and field names, so bulk viewing is visible after the fact.

**Against compromise:** MFA on the Azure and Shopify Partner accounts. Least-privilege access. Dependency alerts reviewed rather than dismissed. Deployment only through the repository's CI workflow.

**Known gaps, stated honestly** — a reviewer respects a named gap more than an absent one, and this list is what the next round of work draws from:

- No automated alerting on anomalous access patterns; detection today depends on someone looking.
- One person, so no separation of duties and no on-call rotation.
- Single Azure environment shared between testing and production.
- No third-party penetration test or security certification.
