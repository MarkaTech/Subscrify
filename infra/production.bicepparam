using './main.bicep'

param envName = 'prod'
param location = 'centralindia'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param deployWorker = true
param deployRedis = true
