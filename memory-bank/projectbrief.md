# ClineCloud — Project Brief

## What Is This?
A cloud-hosted Cline server on Railway. Accepts coding tasks from websites (EveryVPoker admin widget, etc.) via WebSocket, runs Cline CLI against git-cloned project repos, streams progress back in real-time, and auto-pushes changes to GitHub when done. Railway auto-redeploys from GitHub.

## Why?
Replaces the local Mac + Cloudflare tunnel setup (PhoneConnectionToCline). No more tunnel management, no Mac dependency. Always-on cloud server.

## Architecture
```
Phone/Widget → WSS → ClineCloud (Railway) → Cline CLI → edits files in cloned repo → git push → GitHub → Railway auto-redeploy
```

## Key URLs
- **Production**: `https://clinecloud-production.up.railway.app`
- **WebSocket**: `wss://clinecloud-production.up.railway.app`
- **Health**: `GET /api/health`
- **GitHub**: `https://github.com/jk212h20/ClineCloud`

## Railway
- **Project ID**: `8ab2e504-ebd4-45cd-8218-0e047b96167b`
- **Service ID**: `9ea972aa-4204-44a9-a567-76f4b7de945e`
- **Volume**: mounted at `/data` (repos, projects.json, conversation state)

## Tech Stack
- Node.js 20 (Dockerfile: `node:20-slim`)
- Express 5 + ws (WebSocket)
- isomorphic-git (pure JS git — no system binary needed)
- Cline CLI (`cline@2.14.0` installed globally in Docker)

## Environment Variables
| Var | Purpose |
|-----|---------|
| `PIN` | WebSocket auth PIN |
| `GH_TOKEN` | GitHub token for clone/push |
| `PPQ_API_KEY` | LLM API key (passed to Cline) |
| `DATA_DIR` | `/data` (Railway volume) |
| `PORT` | Auto-set by Railway |

## Connected Projects
- **EveryVPoker**: Admin widget at `/admin` → Cline tab → sends tasks to ClineCloud
