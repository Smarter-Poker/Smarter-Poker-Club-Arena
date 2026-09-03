# GitHub Actions Automatic Deployment Setup

This repository uses GitHub Actions to **automatically deploy to production** on every push to `main`.

## How It Works

1. You push code to `main` branch
2. GitHub Actions automatically:
   - Deploys Club Arena to Vercel
   - Refreshes World Hub proxy cache
   - Makes changes live on `smarter.poker/hub/club-arena/`

**No manual steps required!** ✅

## Setup Required (One-Time)

You need to add these secrets to your GitHub repository:

### 1. Get Vercel Token

```bash
npx vercel login
npx vercel token create
```

Copy the token and add it as `VERCEL_TOKEN` in GitHub Secrets.

### 2. Get Vercel Project IDs

```bash
# In club-arena directory
cat .vercel/project.json
```

Add `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` to GitHub Secrets.

```bash
# In Smarter-Poker-World-Hub directory
cat .vercel/project.json
```

Add the project ID as `VERCEL_WORLD_HUB_PROJECT_ID` to GitHub Secrets.

### 3. Create GitHub Personal Access Token

1. Go to GitHub Settings → Developer Settings → Personal Access Tokens
2. Create a token with `repo` scope
3. Add it as `GH_PAT` in GitHub Secrets

### 4. Add Secrets to GitHub

1. Go to your repository on GitHub
2. Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add each secret:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
   - `VERCEL_WORLD_HUB_PROJECT_ID`
   - `GH_PAT`

## After Setup

Just push to `main`:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

GitHub Actions will automatically deploy everything! 🚀

You can watch the deployment progress in the "Actions" tab on GitHub.
