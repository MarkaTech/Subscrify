import type { LoaderFunctionArgs } from "react-router";

/**
 * RFC 9116 security.txt — the published channel for reporting a security
 * vulnerability in Marka Subscrify. Served at /.well-known/security.txt
 * (the flat-routes [.] brackets escape the literal dots).
 *
 * Reports land at the same monitored support address named in the privacy
 * policy and the internal incident-response procedure
 * (docs/security-incident-response.md) — one channel, documented in three
 * places that must stay in agreement.
 *
 * The Expires field is required by the RFC; keep it under a year out and
 * refresh it when it passes (tracked in the launch checklist).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const origin = new URL(request.url).origin;
  const body = [
    "Contact: mailto:support@houseofmarka.com",
    `Canonical: ${origin}/.well-known/security.txt`,
    `Policy: ${origin}/privacy`,
    "Preferred-Languages: en",
    "Expires: 2027-08-01T00:00:00.000Z",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
