# Deploying Fallback Forge to Azure App Service

A step-by-step guide for the first production deployment and for later updates. The end state:

```text
Browser ──► App Service (Linux, B3, 1 instance) ──► Blob Storage (outputs, 7-day expiry)
              │  Sign-in: shared team password (temporary; Okta planned)
              │  Container image pulled from ACR with managed identity
              └─ /healthz health check, HTTPS only, TLS 1.2
```

You can provision everything with one script (**Part B**) or click through it yourself (**Part C**). Either way, how sign-in works and how to manage the password is in **Part D**, and everything is checked in **Part E**.

---

## Part A: Before you start

### A1. Tools and access

- [ ] **Azure CLI** 2.60 or newer: `az version`. Install: <https://learn.microsoft.com/cli/azure/install-azure-cli>.
- [ ] **Git**, run from the repository root on the commit you want to ship.
- [ ] An Azure subscription where you can **create resources and assign roles**: *Owner*, or *Contributor* plus *User Access Administrator*, on the subscription or the target resource group. The script assigns roles (AcrPull, Storage Blob Data Contributor, Storage Blob Delegator); without this right it stops partway through. If you can't get role-assignment rights, ask the subscription owner to run the four `az role assignment create` commands in C4 and C5 for you.
- [ ] **No Microsoft Entra ID setup is needed.** For now, sign-in is a shared team password (Part D).

Docker isn't needed: the image is built in Azure by `az acr build`, which always produces the linux/amd64 image App Service runs.

### A2. Sign in and pick the subscription

```bash
az login
az account list --output table
az account set --subscription "<subscription name or id>"
az account show --query "{name:name, id:id, tenant:tenantId}" --output table
```

Make sure the resource providers are registered (a one-off per subscription; harmless if already done):

```bash
for ns in Microsoft.Web Microsoft.ContainerRegistry Microsoft.Storage; do
  az provider register --namespace "$ns"
done
```

### A3. Corporate proxy (TLS inspection)

If your network inspects TLS (e.g. Netskope or Zscaler) and the CLI fails with `CERTIFICATE_VERIFY_FAILED`, point it at your corporate CA bundle for this shell:

```bash
export REQUESTS_CA_BUNDLE=/path/to/corporate-ca-bundle.pem
```

`az acr build` uploads your source to Azure and builds it there, so the Docker build itself isn't affected by the proxy.

### A4. Choose names

| Setting | Example | Rules |
| --- | --- | --- |
| `APP_NAME` | `fallback-forge-prod` | Globally unique; becomes `https://<APP_NAME>.azurewebsites.net` |
| `SOURCE_URL` | `https://github.com/oumeirapp/gif-forge` | **Public** repository with the `gifski-worker` source. Required by Gifski's AGPL; shown as "Source (AGPL)" in the UI |
| `ACCESS_PASSWORD` | *(choose one)* | Shared team password, at least 8 characters. **Never commit it**; share it with the team privately (e.g. a password manager). Always wrap it in **single quotes** in the shell: characters like `$` are otherwise expanded (`"Ex4mple$$pw"` would silently become `Ex4mple`, the shell's process id, then `pw`) |
| `RESOURCE_GROUP` | `rg-fallback-forge-prod` | Optional, defaults to `rg-<APP_NAME>` |
| `LOCATION` | `westeurope` | Optional, defaults to `westeurope`. List: `az account list-locations -o table` |
| `ACR_NAME` | `fallbackforgeprodacr` | Optional; 5–50 lowercase letters/digits, globally unique |
| `STORAGE_ACCOUNT` | `fallbackforgeprodout` | Optional; 3–24 lowercase letters/digits, globally unique |

> **Before go-live:** the repository at `SOURCE_URL` must be publicly readable. If `oumeirapp/gif-forge` stays private, publish the `gifski-worker` source somewhere public and use that URL.

### A5. Pre-flight check on your machine

```bash
npm install
npm run check        # build + gifski + engine + server tests, all must pass
git status           # commit first: the image is tagged with the current commit
```

---

## Part B: Provision and deploy with the script (recommended)

`infra/deploy.sh` performs every step in Part C. It's safe to re-run; each step creates or updates in place.

### B1. Run it

```bash
APP_NAME=fallback-forge-prod \
SOURCE_URL=https://github.com/oumeirapp/gif-forge \
ACCESS_PASSWORD='<the team password>' \
LOCATION=westeurope \
infra/deploy.sh
```

Expect 10–20 minutes, most of it the image build. It prints a `==>` line per stage:

1. Resource group
2. Container registry and image build (`fallback-forge:<git-sha>`)
3. App Service plan (Linux B3) and web app, with a managed identity
4. `AcrPull` for the web app
5. Storage account, `outputs` container, 7-day lifecycle rule, and roles
6. App settings (including `ACCESS_PASSWORD`, and a generated `SESSION_SECRET` on the first run)
7. General settings (Always On, health check, HTTPS, TLS 1.2, logs)
8. Deploy the image and restart

It ends with `Deployed https://<APP_NAME>.azurewebsites.net`.

### B2. If it stops partway

Fix the cause and **run it again**. Common causes:

- **`AuthorizationFailed` on `az role assignment create`:** you lack *User Access Administrator* or *Owner* (see A1).
- **`The storage account named ... is already taken`** (or the ACR name): set `STORAGE_ACCOUNT=` / `ACR_NAME=` to something unique.
- **`az storage container create` keeps failing:** role assignments take up to ~5 minutes to apply. The script retries for 2 minutes; just re-run it.

The app is then live behind the password login. Read **Part D** for how sign-in works and how to change the password, then run the checks in **Part E**.

---

## Part C: Manual setup (equivalent to the script)

Use this if you prefer the portal, or to understand or repair one piece. Commands assume these shell variables:

```bash
APP_NAME=fallback-forge-prod
SOURCE_URL=https://github.com/oumeirapp/gif-forge
ACCESS_PASSWORD='<the team password>'      # single quotes!
RG=rg-$APP_NAME
LOCATION=westeurope
ACR=fallbackforgeprodacr
STORAGE=fallbackforgeprodout
PLAN=plan-$APP_NAME
TAG=$(git rev-parse --short HEAD)
IMAGE=$ACR.azurecr.io/fallback-forge:$TAG
```

### C1. Resource group

```bash
az group create --name $RG --location $LOCATION
```

Portal: *Resource groups → Create*.

### C2. Container registry and image

```bash
az acr create --resource-group $RG --name $ACR --sku Basic --admin-enabled false
az acr build --registry $ACR --image fallback-forge:$TAG --build-arg VITE_SOURCE_URL=$SOURCE_URL .
az acr repository show-tags --name $ACR --repository fallback-forge --output table
```

The build log should include `OK` from the FFmpeg checksum check and a `libvmaf` filter line. The build fails on purpose if either is missing.

### C3. App Service plan and web app

```bash
az appservice plan create --resource-group $RG --name $PLAN --is-linux --sku B3
az webapp create --resource-group $RG --plan $PLAN --name $APP_NAME --container-image-name $IMAGE
PRINCIPAL_ID=$(az webapp identity assign --resource-group $RG --name $APP_NAME --query principalId --output tsv)
```

Portal: *Create a resource → Web App*. Choose *Publish: Container*, *OS: Linux*, plan *Basic B3*, then *Identity → System assigned: On*.

> Keep the plan at **one instance** (no scale-out or autoscale). Jobs live in the server's memory; a second instance wouldn't know about them.

### C4. Let the app pull from ACR with its identity

```bash
az role assignment create --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope $(az acr show --name $ACR --query id --output tsv)
az webapp config set --resource-group $RG --name $APP_NAME \
  --generic-configurations '{"acrUseManagedIdentityCreds": true}'
```

Portal: *Web app → Deployment Center → Registry settings → Authentication: Managed identity*.

### C5. Storage for outputs

```bash
az storage account create --resource-group $RG --name $STORAGE --location $LOCATION \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false --allow-shared-key-access false
STORAGE_ID=$(az storage account show --resource-group $RG --name $STORAGE --query id --output tsv)

# You need data-plane access to create the container:
az role assignment create --assignee $(az ad signed-in-user show --query id --output tsv) \
  --role "Storage Blob Data Contributor" --scope $STORAGE_ID
az storage container create --account-name $STORAGE --name outputs --auth-mode login   # retry after a few minutes if denied

# The app uploads outputs and signs short-lived download links:
for role in "Storage Blob Data Contributor" "Storage Blob Delegator"; do
  az role assignment create --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal \
    --role "$role" --scope $STORAGE_ID
done
```

**Lifecycle rule** (delete outputs after 7 days). Portal: *Storage account → Lifecycle management → Add rule*, *Block blobs*, prefix `outputs/`, *Base blobs: delete if last modified more than 7 days ago*. Or:

```bash
az storage account management-policy create --resource-group $RG --account-name $STORAGE --policy '{
  "rules":[{"enabled":true,"name":"delete-outputs-after-7-days","type":"Lifecycle",
  "definition":{"filters":{"blobTypes":["blockBlob"],"prefixMatch":["outputs/"]},
  "actions":{"baseBlob":{"delete":{"daysAfterModificationGreaterThan":7}}}}}]}'
```

### C6. App settings (including `ACCESS_PASSWORD`, and a generated `SESSION_SECRET` on the first run)

```bash
az webapp config appsettings set --resource-group $RG --name $APP_NAME --settings \
  WEBSITES_PORT=8080 "ACCESS_PASSWORD=$ACCESS_PASSWORD" "SESSION_SECRET=$(openssl rand -base64 48)" \
  STORAGE=blob AZURE_STORAGE_ACCOUNT=$STORAGE AZURE_STORAGE_CONTAINER=outputs MAX_CONCURRENT_JOBS=2
```

Set `SESSION_SECRET` only once: generating a new one signs everyone out. Don't set `REQUIRE_AUTH`; it's for Easy Auth, which isn't used.

Portal: *Web app → Settings → Environment variables*. Don't add `BANNER_FORGE_CHROMIUM_NO_SANDBOX` yet; see E3. The full list of variables is in [DEVELOPMENT.md](DEVELOPMENT.md#environment-variables).

### C7. General settings, health check, logs

```bash
az webapp config set --resource-group $RG --name $APP_NAME --always-on true --min-tls-version 1.2 \
  --generic-configurations '{"healthCheckPath": "/healthz"}'
az webapp update --resource-group $RG --name $APP_NAME --https-only true
az webapp log config --resource-group $RG --name $APP_NAME --docker-container-logging filesystem
```

Portal: *Configuration → General settings* (Always On, HTTPS Only, Minimum TLS 1.2), *Monitoring → Health check* (path `/healthz`), *Monitoring → App Service logs* (Application logging: File System).

Optional: *Application Insights → Turn on*, for request and failure dashboards.

### C8. Deploy the image

```bash
az webapp config container set --resource-group $RG --name $APP_NAME \
  --container-image-name $IMAGE --container-registry-url https://$ACR.azurecr.io
az webapp restart --resource-group $RG --name $APP_NAME
```

---

## Part D: Sign-in (temporary shared password)

Microsoft Entra ID isn't available for this app, and Okta is planned for a later release. Until then, the app has its own login page protected by one **shared team password**.

### D1. How it works

- The password is stored only in the App Service setting `ACCESS_PASSWORD`, never in the code or the image.
- Visiting the site shows a login page. The right password gives the browser a signed, `HttpOnly`, `Secure`, `SameSite=Strict` session cookie, valid for 12 hours (`SESSION_TTL_MS`). After that, the user is asked to sign in again.
- **Each sign-in is its own private workspace.** People sharing the password can't see or download each other's jobs.
- Repeated wrong passwords from one address are locked out for 15 minutes after 10 failures.
- The health check (`/healthz`) and the page itself load without signing in; every `/api` call needs a session.

### D2. Sharing the password

Give it to the team through a password manager or a private channel, not email or chat history that others can search. Use a long password: anyone who has it, or guesses it, can use the app.

### D3. Changing the password

```bash
az webapp config appsettings set --resource-group $RG --name $APP_NAME --settings 'ACCESS_PASSWORD=<new password>'
```

Changing the app setting restarts the app (running jobs stop). Existing sessions stay valid until they expire. To **sign everyone out immediately** (e.g. after someone leaves the team), also replace `SESSION_SECRET`:

```bash
az webapp config appsettings set --resource-group $RG --name $APP_NAME --settings "SESSION_SECRET=$(openssl rand -base64 48)"
```

### D4. Limits of this approach

This is a stopgap, not individual accounts: there are no per-person logins or audit trail, and anyone with the password has the same access. For extra protection, combine it with network restrictions (*Networking → Access restriction* → allow only your office or VPN ranges).

### D5. Later: Okta

App Service authentication supports any **OpenID Connect** provider, including Okta. The app already understands App Service's user-ID header (`REQUIRE_AUTH=1` mode), so moving to Okta should mostly be configuration:

1. In Okta, create an OIDC *Web* app with sign-in redirect URI `https://<APP_NAME>.azurewebsites.net/.auth/login/<provider-name>/callback`.
2. In the portal: *Authentication → Add identity provider → OpenID Connect*, with Okta's issuer URL, client ID and secret. Require authentication, with a 302 redirect.
3. Remove `ACCESS_PASSWORD` (and `SESSION_SECRET`), and set `REQUIRE_AUTH=1`.
4. Point the UI's sign-out at `/.auth/logout` (already done when `REQUIRE_AUTH=1`).

---

## Part E: Verify the deployment

Work through these in order and tick them off.

### E1. Container started

```bash
az webapp log tail --resource-group $RG --name $APP_NAME
```

- [ ] The log shows Fastify listening on `0.0.0.0:8080`, with no crash loop.
- [ ] *Monitoring → Health check* shows the instance as healthy, or check from the app's console (*Development Tools → SSH*): `curl -s localhost:8080/healthz` returns `{"ok":true,"tools":{"ffmpeg":true,"chromium":true,"gifskiWorker":true}}`.

### E2. Sign-in is enforced

```bash
curl -s https://$APP_NAME.azurewebsites.net/api/session                    # {"mode":"password","authenticated":false}
curl -s -o /dev/null -w "%{http_code}\n" https://$APP_NAME.azurewebsites.net/api/jobs/x   # 401
```

- [ ] `/api/session` reports `"mode":"password"`. If it says `"none"`, `ACCESS_PASSWORD` isn't set and **the app is open to anyone**: fix that first.
- [ ] In a private browser window the site shows the login page. A wrong password shows "Incorrect password."; the right one opens Fallback Forge.
- [ ] **Sign out** (top right) returns to the login page.
- [ ] The header shows the **Source (AGPL)** link, and it opens `SOURCE_URL`.

### E3. A conversion works (and the Chromium sandbox decision)

1. Upload a small banner ZIP (one folder with an `index.html` at a standard size such as 300×250) and choose **Forge GIFs**.
2. [ ] Progress moves through Load → Capture → Encode → Validate, and a result row appears.
3. [ ] The GIF and **Report** links download. They redirect to a `*.blob.core.windows.net/...?sv=...` URL that stops working after an hour.
4. [ ] The report's `encoding.evaluation.mode` is `"vmaf-cambi"` (adaptive dithering active). Tiny banners such as 120×60 fall back to Light Bayer with a warning; that's expected.

**If the conversion fails with a Chromium launch or sandbox error** (e.g. `No usable sandbox`, `Failed to move to new namespace`), App Service doesn't allow Chromium's sandbox. Turn it off and retry:

```bash
az webapp config appsettings set --resource-group $RG --name $APP_NAME --settings BANNER_FORGE_CHROMIUM_NO_SANDBOX=1
```

Record which way it went in `docs/WEB_MIGRATION_STATUS.md` (Phase 6).

### E4. Long batch survives the ~230-second idle limit

App Service closes idle HTTP connections after about 230 s. The app sends a heartbeat every 20 s and resumes automatically, but confirm it:

1. Build a ZIP with **8–10 banner folders**, each with an animation lasting 20–30 s.
2. Choose **Forge GIFs** with *Output mode: Both* and *Dithering: Adaptive*. This should take well over 4 minutes.
3. [ ] Progress keeps updating past the 4-minute mark, and the batch ends with every row present.
4. [ ] Refresh the page in the middle of the batch: it reconnects and carries on.
5. [ ] Start another batch and choose **Cancel**: it stops within a few seconds.

### E5. Sessions can't see each other's jobs

- [ ] Sign in in a second browser (or private window) and open `https://<APP_NAME>.azurewebsites.net/api/jobs/<a jobId from the first browser>`: it returns **404**.

When E1–E5 pass, mark Phase 6 done in [WEB_MIGRATION_STATUS.md](WEB_MIGRATION_STATUS.md).

---

## Part F: Shipping updates

```bash
git pull && npm run check                      # on the commit you want to release
TAG=$(git rev-parse --short HEAD)
az acr build --registry $ACR --image fallback-forge:$TAG --build-arg VITE_SOURCE_URL=$SOURCE_URL .
az webapp config container set --resource-group $RG --name $APP_NAME \
  --container-image-name $ACR.azurecr.io/fallback-forge:$TAG --container-registry-url https://$ACR.azurecr.io
az webapp restart --resource-group $RG --name $APP_NAME
```

Or just re-run `infra/deploy.sh` with the same variables.

> A restart stops queued and running jobs (they live in memory). Ship updates when nobody is mid-batch. Finished outputs already in Blob Storage stay downloadable from their links until the 7-day lifecycle rule removes them.

### Rolling back

Point the app at the previous tag and restart:

```bash
az acr repository show-tags --name $ACR --repository fallback-forge --orderby time_desc --output table
az webapp config container set --resource-group $RG --name $APP_NAME \
  --container-image-name $ACR.azurecr.io/fallback-forge:<previous-tag>
az webapp restart --resource-group $RG --name $APP_NAME
```

---

## Part G: Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Site shows *Application Error* / container keeps restarting | `az webapp log tail`. Check `WEBSITES_PORT=8080` is set, and that the image pull worked (AcrPull role + `acrUseManagedIdentityCreds`). |
| `ImagePullFailure` / `unauthorized` pulling from ACR | Role assignments take a few minutes. Re-check C4, then restart. |
| Login page says "Incorrect password." with the right password | The value was mangled by the shell when it was set (usually unquoted `$`). Re-set it with single quotes (D3). |
| "Too many failed attempts" | 10 wrong passwords from your address in 15 minutes. Wait it out, or restart the app to clear the counter. |
| Signed out unexpectedly | The session lasts 12 h (`SESSION_TTL_MS`), and a new `SESSION_SECRET` signs everyone out. If `SESSION_SECRET` is missing, every restart signs everyone out: set it (C6). |
| No login page; the app opens directly | `ACCESS_PASSWORD` isn't set, so the app is **unprotected**. Set it now (D3). |
| Downloads return 403 from `blob.core.windows.net` | The app identity lacks **Storage Blob Delegator** or **Storage Blob Data Contributor** (C5), or the roles haven't applied yet. |
| Result row shows "Could not store output" | Same as above, or `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_CONTAINER` is wrong. |
| `/healthz` returns 503 | The JSON names the missing tool. The image sets all three paths, so this usually means a broken image: rebuild. |
| Chromium launch or sandbox errors | Set `BANNER_FORGE_CHROMIUM_NO_SANDBOX=1` (E3). |
| Adaptive dithering always "Light Bayer" with a warning | Expected for tiny banners (CAMBI can't handle about 128×64 and smaller). For normal sizes, check the build log showed the `libvmaf` line. |
| Progress stops updating on long jobs | Check nothing between the browser and App Service (a corporate proxy or another CDN) buffers `text/event-stream`. The job keeps running; refreshing the page reattaches. |
| Upload rejected with 400/413 | The message names the limit or the bad path. Raise `MAX_UPLOAD_BYTES`, `MAX_UNZIPPED_BYTES`, `MAX_FILES` or `MAX_BANNERS_PER_JOB` in app settings if the content is legitimate. |

---

## Part H: Removing everything

Deletes the app, registry, images, and all stored outputs. This can't be undone.

```bash
az group delete --name $RG --yes
```

Also remove the shared password from wherever the team stored it.
