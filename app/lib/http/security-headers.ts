/**
 * Security headers for the app's PUBLIC pages — the marketing landing page,
 * /privacy, /terms, and /.well-known/security.txt.
 *
 * Scope matters here: these headers must NOT be applied to embedded-admin
 * routes. `frame-ancestors 'none'` / X-Frame-Options DENY would break the
 * app inside the Shopify admin iframe — embedded routes get their (correct,
 * shop-specific) CSP from Shopify's own addDocumentResponseHeaders +
 * boundary.headers instead. Public pages have no business being framed by
 * anyone, so they lock framing down completely.
 *
 * script-src includes 'unsafe-inline' because React Router streams an
 * inline hydration script into every document response — removing it
 * breaks hydration on the landing page. All other script sources are
 * self-hosted (no CDNs anywhere in the app), so 'self' covers the rest.
 */
export function publicPageHeaders(): HeadersInit {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}
