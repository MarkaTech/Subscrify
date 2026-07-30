using './main.bicep'

param envName = 'staging'
// Region decision pending owner confirmation (free-credit subscription).
// Default: Central India. Change here only — never in the portal.
param location = 'centralindia'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param deployWorker = false
param deployRedis = false
