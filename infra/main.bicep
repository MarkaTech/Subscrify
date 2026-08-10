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

@description('Shopify app client ID (public identifier).')
param shopifyApiKey string = ''

@description('Shopify app client secret — supplied at deploy time from CI secrets.')
@secure()
param shopifyApiSecret string = ''

@description('Public HTTPS URL of this app (the container app ingress FQDN).')
param appUrl string = ''

@description('ACR login server the web image is pulled from (system identity must hold AcrPull).')
param containerRegistryServer string = 'caca4d77ed2eacr.azurecr.io'

@description('Shopify access scopes, mirrored from shopify.app.toml.')
param shopifyScopes string = 'write_products,write_purchase_options,read_customer_payment_methods,read_own_subscription_contracts,write_own_subscription_contracts,read_customers,read_orders'

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
      // Registry auth for pulling the app image. Without this the revision
      // dies in ImagePullBackOff — the system identity holds AcrPull, but the
      // app must still be told to use it for this registry.
      registries: empty(containerRegistryServer) ? [] : [
        {
          server: containerRegistryServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://subscrify:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/subscrify?sslmode=require'
        }
        {
          name: 'shopify-api-secret'
          value: shopifyApiSecret
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
          name: 'web'
          image: webImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SHOPIFY_API_KEY', value: shopifyApiKey }
            { name: 'SHOPIFY_API_SECRET', secretRef: 'shopify-api-secret' }
            { name: 'SHOPIFY_APP_URL', value: appUrl }
            { name: 'SCOPES', value: shopifyScopes }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'SERVICEBUS_CONNECTION', secretRef: 'servicebus-connection' }
            // Scheduler ticks inside this always-on web process (the worker
            // scales to zero — see run-scheduler.server.ts) and only makes
            // sense once something is actually consuming the queue.
            { name: 'ENABLE_BILLING_SCHEDULER', value: deployWorker ? 'true' : 'false' }
          ]
        }
      ]
      scale: {
        // Always keep one replica warm: embedded-admin iframes time out on
        // cold starts, which reads as a blank app page.
        minReplicas: 1
        maxReplicas: 4
      }
    }
  }
}

// Billing worker (Phase 4) — same image as web, command overridden to run
// the worker entrypoint instead of the web server. Scales on Service Bus
// queue depth (KEDA), including down to zero when there's nothing to do.
resource workerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployWorker) {
  name: '${prefix}-worker'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      // Same registry auth as web — this is the same image.
      registries: empty(containerRegistryServer) ? [] : [
        {
          server: containerRegistryServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://subscrify:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/subscrify?sslmode=require'
        }
        {
          name: 'servicebus-connection'
          value: listKeys('${serviceBus.id}/AuthorizationRules/RootManageSharedAccessKey', serviceBus.apiVersion).primaryConnectionString
        }
        {
          name: 'shopify-api-secret'
          value: shopifyApiSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: webImage
          // Runs `prisma generate` (no migrate deploy — the web container
          // already owns applying migrations, running it from both would
          // race) then the Service Bus consumer. Same image, different
          // process — see app/worker/index.ts.
          command: ['npm', 'run', 'docker-worker']
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'SERVICEBUS_CONNECTION', secretRef: 'servicebus-connection' }
            // The worker builds its own shop-scoped admin clients via
            // unauthenticated.admin(shop) (app/shopify.server.ts), which
            // needs the same app identity/config as the web process.
            { name: 'SHOPIFY_API_KEY', value: shopifyApiKey }
            { name: 'SHOPIFY_API_SECRET', secretRef: 'shopify-api-secret' }
            { name: 'SHOPIFY_APP_URL', value: appUrl }
            { name: 'SCOPES', value: shopifyScopes }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'NODE_ENV', value: 'production' }
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

// The web app's system identity was granted AcrPull manually, out-of-band,
// before this template existed (see containerRegistryServer's @description).
//
// The worker app's identity was ALSO granted AcrPull manually, out-of-band
// (2026-07-31) — see claude/subscrify-status.md for the full story. Short
// version: this template used to declare that grant as a
// Microsoft.Authorization/roleAssignments resource (commit 223d1ce), on the
// theory that every future new-identity Container App would then get pull
// access automatically instead of needing another manual step. That's still
// true in principle, but in practice the GitHub Actions deploy identity only
// has Contributor on this resource group, and creating a roleAssignments
// resource requires roleAssignments/write — which Contributor explicitly
// excludes by Azure design. So EVERY deploy attempt failed at this step with
// AuthorizationFailed, even after the assignment already existed, because
// ARM re-evaluates (re-PUTs) every resource in the template on every
// deployment regardless of whether it's a no-op. Confirmed via three
// identical failures (runs #20-24) before diagnosing this.
//
// Fix: dropped the Bicep-managed role assignment and rely on the manual
// grant instead — same tradeoff the web app already lived with for its
// whole lifetime. The cost: any FUTURE Container App this template adds
// will need its identity granted AcrPull manually too (same one-liner used
// this time: `az role assignment create --assignee <principalId> --role
// AcrPull --scope <acr-resource-id>`), rather than picking it up for free.
// That's a fine tradeoff for a project this size; if it becomes a recurring
// pain, the real fix is granting the deploy identity `User Access
// Administrator` scoped to just the ACR, which was never actually done.

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
