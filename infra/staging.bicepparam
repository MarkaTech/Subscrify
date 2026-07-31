using './main.bicep'

param envName = 'staging'
// Region decision pending owner confirmation (free-credit subscription).
// Default: Central India. Change here only — never in the portal.
param location = 'centralindia'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param shopifyApiKey = 'fc17a27061513df7a7c4dda09476d3cb'
param shopifyApiSecret = readEnvironmentVariable('SHOPIFY_API_SECRET', '')
param appUrl = 'https://subscrify-staging-web.victoriousriver-73bb1ad1.centralindia.azurecontainerapps.io'
param deployWorker = true
param deployRedis = false
