# Privacy Policy — Marka Subscrify

**Last updated: 26 August 2026**

Marka Subscrify ("the app") is a Shopify app published by **MARKA MODERN RETAIL PRIVATE LIMITED** ("we", "us"), a company incorporated in India, trading as House of Marka, with its registered office at Basement, Plot No. 39, Sector 27, Gurugram, Haryana 122001, India. This policy explains what personal data the app handles, why, and what we do and don't keep.

It covers the app only. It does not cover the practices of the merchants who install it — each Shopify store has its own privacy policy governing how that store treats its customers' data.

## 1. The short version

Marka Subscrify stores **no personal data belonging to a store's customers**. A subscriber's name and email address are read live from Shopify each time a merchant opens a subscription page, shown on screen, and discarded when the page is done. They are never written to our database.

We never see or handle payment details. Card numbers, wallets and mandates stay inside Shopify's payment system; the app asks Shopify to charge an existing subscription and receives back only whether the charge succeeded.

What we do store is the small amount of operational data described in section 3: which Shopify store you are, a token that lets the app talk to your store, and a log of which subscription charges were attempted and how they turned out.

## 2. Who the data belongs to, and our role

There are two distinct groups of people in this policy, and our obligations differ for each.

**Merchants and their staff.** If you install the app or use it inside your Shopify admin, we are the **controller** of the limited account data described below — we decide why we hold it (so the app can function and so we can support you).

**Store customers and subscribers.** When the app touches data about the people who buy from a merchant's store, we act only as a **processor** on that merchant's instructions. The merchant is the controller. We process that data solely to provide the app's functionality, and never for our own purposes.

## 3. What the app stores

Everything the app keeps in its own database falls into exactly two categories.

| What | Fields | Why |
|---|---|---|
| Shopify session | Store domain, API access token, session state and expiry, and — for logged-in staff sessions — the Shopify staff user's id, first and last name, email address, locale, and whether they own the account | Required by Shopify's app framework to authenticate the app to your store and to identify the staff member using it |
| Subscription billing attempts | Store domain, subscription contract identifier, billing cycle number, attempt number, idempotency key, status, Shopify's billing attempt identifier, any error code and message, and timestamps | To guarantee a subscription is never charged twice for the same cycle, to retry a failed renewal, and to show a merchant what happened to a charge |

Neither table holds a store customer's name, email address, postal address, phone number or payment details.

The app also produces operational logs: request and error telemetry through Azure Application Insights, and an access log recording that a member of staff opened a page displaying subscriber details — the store, the staff user id, the subscription identifier, and **which** fields were displayed, never their values. The access log exists so that a merchant can be told who looked at what if they ever need to know.

## 4. Customer data the app reads but does not keep

To display a subscription, the app requests the subscriber's **name** and **email address** from Shopify's API, and the associated order reference, using access the merchant granted at install. These are rendered in the merchant's browser and are not stored, cached, exported, or transmitted anywhere else. Postal address and phone number are deliberately not requested at all, because the app has no use for them.

If a merchant's Shopify configuration does not grant access to those fields, the app degrades to showing the subscription without them rather than failing.

## 5. Why we process data

Merchant and staff data is processed to operate the app, authenticate requests to the correct store, and provide support when asked. Subscriber data is processed to display who a subscription belongs to and to execute the recurring charges the customer themselves set up at checkout.

We do not use any of it for advertising, profiling, automated decision-making, model training, or resale. We do not build a cross-merchant view of anything.

## 6. Who else sees it

We do not sell, rent or trade personal data, and we do not share it with third parties for their own purposes. Two service providers necessarily handle data on our behalf:

**Microsoft Azure** hosts the application, its database, its message queue and its logs, in Microsoft's **Central India** region. Microsoft acts as our sub-processor under its standard data protection terms.

**Shopify** is the source of the data and the platform the app runs inside. Shopify's handling of merchant and customer data is governed by Shopify's own agreements with the merchant.

We will disclose data if compelled by a valid legal process, and will tell the affected merchant unless prohibited from doing so.

## 7. How long we keep it

Session records are deleted when the app is uninstalled from a store.

Billing attempt records are retained for **24 months** from the date of the attempt on an active store, after which they are deleted automatically by a scheduled purge. They are deleted in full, ahead of that period, when Shopify sends us a shop erasure request — which happens roughly 48 hours after an app is uninstalled.

Operational and access logs are retained for the period configured on our Azure Log Analytics workspace, currently **30 days**.

## 8. Requests from customers

Shopify sends the app three mandatory privacy webhooks, and the app handles all three.

When a customer asks a merchant for the data held about them, we receive that request and confirm that the app holds no stored personal data about that customer — because it doesn't. When a customer asks to be erased, there is correspondingly nothing for us to delete. When a store itself is erased, we delete that store's billing history and sessions entirely.

A customer who wants to exercise any right should contact the merchant they bought from, since the merchant is the controller of that relationship. Merchants can reach us at the address in section 12 and we will assist within the timeframes their own obligations require.

## 9. Security

The app runs on Azure Container Apps behind HTTPS-only ingress. The database is Azure Database for PostgreSQL Flexible Server: it is not reachable from the public internet, connections require TLS, and both the live data and its automated backups are encrypted at rest with AES-256 using Microsoft-managed keys. Shopify API credentials and the database password are held as secrets in the platform's secret store, not in source code.

Access to the production environment is limited to the operator of the company on a least-privilege basis. Every database query the app makes is scoped to a single store, so one merchant's data cannot be returned to another.

No system is perfectly secure. We maintain a written incident response procedure, and if a breach affecting personal data occurs we will notify affected merchants without undue delay and within the timeframes required by applicable law.

## 10. International transfers

Data is stored in India. Where a merchant or their customers are in the European Economic Area or the United Kingdom, transfers to India rely on the Standard Contractual Clauses incorporated into our Data Processing Addendum, together with the technical measures described in section 9. Merchants who need the DPA countersigned should contact us.

## 11. Your rights

Depending on where you live, you may have rights to access, correct, delete, restrict or object to the processing of your personal data, to receive it in a portable form, and to complain to a supervisory authority. This includes rights under the EU and UK GDPR, India's Digital Personal Data Protection Act 2023, and the California Consumer Privacy Act.

We have never sold or shared personal data for cross-context behavioural advertising, and we do not process the data of anyone we know to be under 16.

To exercise a right, or to raise a grievance under the DPDP Act, contact our designated Grievance Officer at the address in section 12, marking your message "Attention: Grievance Officer". We respond within 30 days.

## 12. Contact

MARKA MODERN RETAIL PRIVATE LIMITED
Basement, Plot No. 39, Sector 27, Gurugram, Haryana 122001, India
Email: support@houseofmarka.com

## 13. Changes

If we change this policy we will update the date at the top and, for any change that materially affects how merchant or customer data is handled, notify merchants inside the app or by email before it takes effect.
