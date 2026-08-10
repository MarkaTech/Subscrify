using './main.bicep'

param envName = 'prod'
param location = 'centralindia'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param shopifyApiKey = 'fc17a27061513df7a7c4dda09476d3cb'
param shopifyApiSecret = readEnvironmentVariable('SHOPIFY_API_SECRET', '')

// Chicken-and-egg: this must be the prod container app's ingress FQDN, which
// doesn't exist until the first deploy creates it. Deploy once with this empty
// (the app will boot but OAuth callbacks won't resolve), read the FQDN from the
// deploy output or `az containerapp show -n subscrify-prod-web -g subscrify-prod
// --query properties.configuration.ingress.fqdn -o tsv`, paste it here, and
// deploy again. Staging went through exactly this and its value is hardcoded in
// staging.bicepparam the same way.
param appUrl = ''

param deployWorker = true

// Deliberately FALSE, despite Phase 4 being live. main.bicep provisions a Redis
// instance when this is true but nothing consumes it — no connection string is
// wired into either container app, and no code reads one. Turning it on today
// bills for an idle cache. Flip it when something actually uses Redis, and wire
// the connection string through at the same time.
param deployRedis = false
