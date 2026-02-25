# Deploying EuroLeague Quiz to Azure

This guide walks you through deploying the app on Azure for **~$13/month**.

## Architecture

| Component | Azure Service | Cost |
|-----------|---------------|------|
| Frontend (React SPA) | Azure Static Web Apps — Free tier | $0 |
| Backend (FastAPI) | Azure App Service — B1 Linux | ~$13/mo |
| Database (SQLite) | File on App Service disk | $0 |

## Prerequisites

- An Azure subscription (the $75/month free credits work perfectly)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- GitHub repository (for CI/CD)

## Step 1: Create Azure Resources

### Login to Azure CLI

```bash
az login
```

### Create a Resource Group

```bash
az group create --name euroleague-quiz-rg --location westeurope
```

Pick a region close to you. Options: `westeurope`, `northeurope`, `eastus`, etc.

### Create an App Service Plan (Backend)

```bash
az appservice plan create --name euroleague-quiz-plan --resource-group euroleague-quiz-rg --sku B1 --is-linux
```

### Create the Web App (Backend)

```bash
az webapp create --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --plan euroleague-quiz-plan --runtime "PYTHON:3.11"
```

> **Note:** Replace `euroleague-quiz-backend-app` with a globally unique name. This becomes your URL: `https://euroleague-quiz-backend-app.azurewebsites.net`.

### Enable WebSockets

```bash
az webapp config set --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --web-sockets-enabled true
```

### Set the Startup Command

```bash
az webapp config set --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --startup-file "pip install . && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"
```

### Configure Environment Variables

```bash
az webapp config appsettings set --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --settings ELQ_DATABASE_URL="sqlite:///data/euroleague.db" ELQ_CORS_ORIGINS="https://your-frontend.azurestaticapps.net"
```

> **Note:** Update `ELQ_CORS_ORIGINS` after you create the Static Web App and know the frontend URL.

### Create the Static Web App (Frontend)

The easiest way is through the [Azure Portal](https://portal.azure.com):

1. Go to **Create a resource** → **Static Web App**
2. Choose **Free** plan
3. Connect to your GitHub repo
4. Set:
   - **App location**: `frontend`
   - **Build preset**: `React`
   - **Output location**: `dist`
5. Click **Create**

Azure will automatically create a GitHub Actions workflow. You can merge it with the existing `deploy.yml` or keep them separate.

## Step 2: Enable Basic Auth & Configure GitHub Secrets

Azure disables basic auth by default. Enable it so you can download the publish profile.

First, get your subscription ID:

```bash
az account show --query id -o tsv
```

Then enable basic auth (replace `<SUB_ID>` with the output above):

```bash
az resource update --ids "/subscriptions/1da9f61a-0317-4368-bc96-d2371dc650a1/resourceGroups/euroleague-quiz-rg/providers/Microsoft.Web/sites/euroleague-quiz-backend-app/basicPublishingCredentialsPolicies/ftp" --set properties.allow=true

az resource update --ids "/subscriptions/1da9f61a-0317-4368-bc96-d2371dc650a1/resourceGroups/euroleague-quiz-rg/providers/Microsoft.Web/sites/euroleague-quiz-backend-app/basicPublishingCredentialsPolicies/scm" --set properties.allow=true
```

> **Note:** Replace `euroleague-quiz-backend-app` with your actual App Service name in both commands.

Now configure GitHub secrets. In your GitHub repo → **Settings** → **Secrets and variables** → **Actions**, add:

| Secret | How to get it |
|--------|---------------|
| `AZURE_WEBAPP_PUBLISH_PROFILE` | Azure Portal → your Web App → **Download publish profile** (download XML, paste entire file contents) |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Azure Portal → your Static Web App → **Manage deployment token** |

## Step 3: Update Configuration

### Backend App Service name

Edit `.github/workflows/deploy.yml` and replace `euroleague-quiz-backend-app` with your actual App Service name:

```yaml
env:
  AZURE_WEBAPP_NAME: your-actual-app-name
```

### Frontend production URL

Edit `frontend/.env.production` and set your backend URL:

```
VITE_API_URL=https://your-actual-app-name.azurewebsites.net
```

### CORS origins

Update the App Service env var with your actual frontend URL:

```bash
az webapp config appsettings set --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --settings ELQ_CORS_ORIGINS="https://your-frontend-name.azurestaticapps.net"
```

## Step 4: Upload the Database

The SQLite database needs to be uploaded to the App Service. Use SSH or Kudu:

### Option A: Via Kudu (browser)

1. Go to `https://euroleague-quiz-backend-app.scm.azurewebsites.net`
2. Navigate to **Debug console** → **CMD**
3. Navigate to `/home/site/wwwroot/data/`
4. Drag and drop `euroleague.db` to upload

### Option B: Via Azure CLI

```bash
az webapp deploy --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg --src-path backend/data/euroleague.db --target-path data/euroleague.db --type static
```

## Step 5: Deploy

Push to `main` and the GitHub Actions workflow will deploy automatically:

```bash
git add .
git commit -m "Add Azure deployment configuration"
git push origin main
```

## Data Ingestion

Data ingestion (fetching from EuroLeague API) should be run **locally**, not on Azure:

```bash
cd backend
.venv\Scripts\activate
python -m ingestion.ingest --start-season 2024 --end-season 2025
```

After ingestion, re-upload the updated `euroleague.db` to Azure using Step 4.

## Troubleshooting

### Check backend logs

```bash
az webapp log tail --name euroleague-quiz-backend-app --resource-group euroleague-quiz-rg
```

### Check if the backend is running

Visit `https://euroleague-quiz-backend-app.azurewebsites.net/docs` — you should see the Swagger UI.

### WebSocket issues

Make sure WebSockets are enabled (Step 1). App Service B1+ is required for WebSocket support.

### CORS errors

Check that `ELQ_CORS_ORIGINS` includes your exact frontend URL (no trailing slash).

## Cost Management

With the B1 plan + Free Static Web Apps, your monthly cost is **~$13**.

If you want to go even cheaper:
- Use **Azure Container Apps** (consumption plan) instead of App Service — you only pay per request, which can be <$1/month for low traffic. Requires the Dockerfile included in `backend/Dockerfile`.

To monitor costs: Azure Portal → **Cost Management** → **Cost analysis**.
