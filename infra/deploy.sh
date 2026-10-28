#!/usr/bin/env bash
# Provision and deploy Fallback Forge to Azure App Service (Linux container).
# Safe to re-run: every step creates or updates in place. Needs the Azure CLI, signed in
# (`az login`) with Owner or User Access Administrator on the resource group, because it
# assigns roles. No secrets are written to the repository; the app uses managed identity.
#
# Usage (from the repository root):
#   APP_NAME=fallback-forge-prod SOURCE_URL=https://github.com/<org>/gif-forge infra/deploy.sh
#
# Easy Auth (Entra ID sign-in) is configured separately; see docs/DEVELOPMENT.md.
set -euo pipefail

: "${APP_NAME:?Set APP_NAME (globally unique, becomes <APP_NAME>.azurewebsites.net)}"
: "${SOURCE_URL:?Set SOURCE_URL to the public source repository (Gifski AGPL requirement)}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-${APP_NAME}}"
LOCATION="${LOCATION:-westeurope}"
ACR_NAME="${ACR_NAME:-$(echo "${APP_NAME}acr" | tr -cd 'a-z0-9' | cut -c1-50)}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-$(echo "${APP_NAME}out" | tr -cd 'a-z0-9' | cut -c1-24)}"
PLAN_NAME="${PLAN_NAME:-plan-${APP_NAME}}"
CONTAINER_NAME="${CONTAINER_NAME:-outputs}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${ACR_NAME}.azurecr.io/fallback-forge:${IMAGE_TAG}"

echo "==> Resource group ${RESOURCE_GROUP} (${LOCATION})"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> Container registry ${ACR_NAME} and image ${IMAGE}"
az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --admin-enabled false --output none
# App Service runs linux/amd64; ACR Tasks builds that by default.
az acr build --registry "$ACR_NAME" --image "fallback-forge:${IMAGE_TAG}" \
  --build-arg "VITE_SOURCE_URL=${SOURCE_URL}" .

echo "==> App Service plan ${PLAN_NAME} (Linux B3) and web app ${APP_NAME}"
az appservice plan create --resource-group "$RESOURCE_GROUP" --name "$PLAN_NAME" --is-linux --sku B3 --output none
if ! az webapp show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none 2>/dev/null; then
  az webapp create --resource-group "$RESOURCE_GROUP" --plan "$PLAN_NAME" --name "$APP_NAME" \
    --container-image-name "$IMAGE" --output none
fi
PRINCIPAL_ID="$(az webapp identity assign --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --query principalId --output tsv)"

echo "==> Let the web app pull from ACR with its managed identity (AcrPull)"
ACR_ID="$(az acr show --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query id --output tsv)"
az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope "$ACR_ID" --output none
az webapp config set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --generic-configurations '{"acrUseManagedIdentityCreds": true}' --output none

echo "==> Storage account ${STORAGE_ACCOUNT}, private container ${CONTAINER_NAME}, 7-day lifecycle rule"
az storage account create --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT" --location "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false \
  --allow-shared-key-access false --output none
STORAGE_ID="$(az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT" --query id --output tsv)"
# The signed-in user needs data-plane access to create the container.
az role assignment create --assignee "$(az ad signed-in-user show --query id --output tsv)" \
  --role "Storage Blob Data Contributor" --scope "$STORAGE_ID" --output none
for attempt in 1 2 3 4 5 6; do
  az storage container create --account-name "$STORAGE_ACCOUNT" --name "$CONTAINER_NAME" --auth-mode login --output none && break
  echo "    waiting for role assignment to propagate (${attempt})"; sleep 20
done
az storage account management-policy create --resource-group "$RESOURCE_GROUP" --account-name "$STORAGE_ACCOUNT" \
  --policy "$(cat <<JSON
{"rules":[{"enabled":true,"name":"delete-outputs-after-7-days","type":"Lifecycle",
  "definition":{"filters":{"blobTypes":["blockBlob"],"prefixMatch":["${CONTAINER_NAME}/"]},
  "actions":{"baseBlob":{"delete":{"daysAfterModificationGreaterThan":7}}}}}]}
JSON
)" --output none
# Blob Data Contributor to upload; Blob Delegator to sign user-delegation SAS download URLs.
for role in "Storage Blob Data Contributor" "Storage Blob Delegator"; do
  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "$role" --scope "$STORAGE_ID" --output none
done

echo "==> App settings"
az webapp config appsettings set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none --settings \
  WEBSITES_PORT=8080 \
  REQUIRE_AUTH=1 \
  STORAGE=blob \
  AZURE_STORAGE_ACCOUNT="$STORAGE_ACCOUNT" \
  AZURE_STORAGE_CONTAINER="$CONTAINER_NAME" \
  MAX_CONCURRENT_JOBS=2
# Only if /healthz or capture fails with Chromium sandbox errors:
#   az webapp config appsettings set -g "$RESOURCE_GROUP" -n "$APP_NAME" --settings BANNER_FORGE_CHROMIUM_NO_SANDBOX=1

echo "==> General settings: Always On, health check, HTTPS only, TLS 1.2, logs"
az webapp config set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --always-on true \
  --min-tls-version 1.2 --generic-configurations '{"healthCheckPath": "/healthz"}' --output none
az webapp update --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --https-only true --output none
az webapp log config --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --docker-container-logging filesystem --output none

echo "==> Deploy image ${IMAGE}"
az webapp config container set --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" \
  --container-image-name "$IMAGE" --container-registry-url "https://${ACR_NAME}.azurecr.io" --output none
az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none

echo
echo "Deployed https://${APP_NAME}.azurewebsites.net"
echo "Next: turn on Easy Auth (Microsoft identity provider) as described in docs/DEVELOPMENT.md."
echo "Until then every /api request returns 401 because REQUIRE_AUTH=1."
