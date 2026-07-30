// Subscrify infrastructure — everything as code, nothing hand-created.
// Scope: one resource group per environment (subscrify-staging / subscrify-prod).
//
// Sizing philosophy: cheapest tiers that keep the real architecture.
// Scaling up later is a parameter change, not a rebuild.

targetScope = 'resourceGroup'

@allowed(['staging', 'prod'])
param envName string

param location string = resourceGroup().location

@description('PostgreSQL admin password. Supplied at deploy time; stored in Key Vault.')
@secure()
param postgresAdminPassword string

@description('Container image for the Remix web app. Placeholder until first app build.')
param webImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Deploy the worker container app (billing engine — Phase 4).')
param deployWorker bool = false

@description('Deploy Azure Cache for Redis (sessions/rate limiting — used from Phase 4).')
param deployRedis bool = false

var prefix = 'subscrify-${envName}'
// Key Vault names: 3-24 chars, alphanumeric + dashes.
var kvName = 'subscrify-${envName}-kv'

// ---------------------------------------------------------------- monitoring
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-appinsights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ---------------------------------------------------------------- key vault
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource pgPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-admin-password'
  properties: {
    value: postgresAdminPassword
  }
}

// ---------------------------------------------------------------- postgres
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg'
  location: location
  sku: {
    name: 'Standard_B1ms' // burstable; bump to Standard_D2ds_v5 as merchants grow
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'subscrify'
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled' // enable ZoneRedundant for prod at launch
    }
  }
}

resource pgFirewallAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'allow-azure-services'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource appDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'subscrify'
}

// ---------------------------------------------------------------- service bus
resource serviceBus 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: '${prefix}-bus'
  location: location
  sku: {
    name: 'Standard' // needed for scheduled messages used by dunning retries
    tier: 'Standard'
  }
}

resource billingQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: serviceBus
  name: 'billing-attempts'
  properties: {
    // One message per contract-cycle. Duplicate detection is a second wall
    // against double-charging (invariant #1) alongside Shopify idempotency keys.
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'P1D'
    lockDuration: 'PT5M'
    maxDeliveryCount: 5 // then dead-letter; alerts watch the DLQ
    deadLetteringOnMessageExpiration: true
  }
}

// ---------------------------------------------------------------- redis (optional until Phase 4)
resource redis 'Microsoft.Cache/redis@2024-03-01' = if (deployRedis) {
  name: '${prefix}-redis'
  location: location
  properties: {
    sku: {
      name: 'Basic'
      family: 'C'
      capacity: 0
    }
    minimumTlsVersion: '1.2'
  }
}

// ---------------------------------------------------------------- container apps
resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-web'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        allowInsecure: false
      }
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://subscrify:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/subscrify?sslmode=require'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'NODE_ENV', value: 'production' }
          ]
        }
      ]
      scale: {
        minReplicas: envName == 'prod' ? 1 : 0
        maxReplicas: 4
      }
    }
  }
}

// Billing worker — created in Phase 4; scales on Service Bus queue depth (KEDA).
resource workerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployWorker) {
  name: '${prefix}-worker'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://subscrify:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/subscrify?sslmode=require'
        }
        {
          name: 'servicebus-connection'
          value: listKeys('${serviceBus.id}/AuthorizationRules/RootManageSharedAccessKey', serviceBus.apiVersion).primaryConnectionString
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: webImage // replaced with the worker image in Phase 4
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SERVICEBUS_CONNECTION', secretRef: 'servicebus-connection' }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 8
        rules: [
          {
            name: 'billing-queue-depth'
            custom: {
              type: 'azure-servicebus'
              metadata: {
                queueName: 'billing-attempts'
                messageCount: '20'
              }
              auth: [
                {
                  secretRef: 'servicebus-connection'
                  triggerParameter: 'connection'
                }
              ]
            }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------- alerts
resource dlqAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${prefix}-billing-dlq-alert'
  location: 'global'
  properties: {
    severity: 1
    enabled: true
    scopes: [serviceBus.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'dead-lettered-messages'
          metricName: 'DeadletteredMessages'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: []
  }
}

output webAppFqdn string = webApp.properties.configuration.ingress.fqdn
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output keyVaultName string = keyVault.name
output serviceBusNamespace string = serviceBus.name
