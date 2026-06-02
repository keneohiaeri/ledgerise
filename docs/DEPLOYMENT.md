# Ledgerise Deployment Guide

## Architecture Overview

Ledgerise is a monorepo with three deployable pieces:

| Service | Description | Default port |
|---|---|---|
| `apps/api` | Node.js HTTP API (TypeScript, compiled to `dist/`) | 3000 |
| `apps/web` | React dashboard (Vite SPA, compiled to static files) | 3001 (dev/staging) |
| `apps/worker` | Background job runner (optional, for scheduled posting) | — |

In production the frontend static files are served by nginx (VPS) or a static site hosting service (Render/Railway) — not directly by Node.js. The API and frontend communicate over HTTP; the frontend only needs to know the API's public URL at build time via `VITE_API_BASE_URL`.

The API and web frontend are independent — the frontend only needs a URL to reach the API.

---

## Environment Variables

### Required (API)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgres://user:pass@host:5432/ledgerise` |
| `LEDGERISE_BOOTSTRAP_ADMIN_EMAIL` | Email for the first admin user (created on startup if not exists) |
| `LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD` | Initial password for the bootstrap admin — change on first login |

### Optional (API)

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `3000` | Port the API listens on |
| `AUTH_TOKEN_SECRET` | `ledgerise-local-development-secret` | HMAC secret for dashboard session tokens — **must be set in production** |
| `LEDGERISE_CREDENTIALS_KEY` | — | 32-byte AES-256-GCM key for adapter credential encryption. Provide as 64 hex chars (`openssl rand -hex 32`). If absent, credentials stored as plaintext — **must be set in production** |
| `DEFAULT_OPERATOR_ID` | — | Override the operator UUID directly |
| `DEFAULT_OPERATOR_SLUG` | `local-operator` | Slug used to look up the default operator if `DEFAULT_OPERATOR_ID` is not set |
| `INGEST_RATE_LIMIT` | `120` | Max ingest requests per minute per source IP |
| `LEDGERISE_BOOTSTRAP_ADMIN_NAME` | `Ledgerise Admin` | Display name for the bootstrap admin |

### Required (web frontend build)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:3000` | Public URL of the API, used at Vite build time |

---

## Building for Production

```bash
# Install all workspace dependencies
npm install

# Build every package in dependency order
npm run build
```

This compiles:
- All `core/*` and `adapters/*` packages (TypeScript → `dist/`)
- `apps/api` → `apps/api/dist/index.js`
- `apps/web` → `apps/web/dist/` (static HTML/JS/CSS)
- `apps/worker` → `apps/worker/dist/index.js`

---

## Running Database Migrations

Run every migration in order. They are idempotent — safe to re-run.

```bash
for f in infra/migrations/*.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

Seed the default operator (required before first API start):

```bash
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql
```

---

## Procfile

A `Procfile` is included at the project root for platforms that support it (Railway, Render, Heroku, Dokku):

```
web: node apps/api/dist/index.js
worker: node apps/worker/dist/index.js
```

The web frontend is a static build — deploy it separately as a static site or serve it via nginx. It is not a Node process.

---

## Deployment Options

### Option A — VPS (Ubuntu/Debian)

Suitable for full control over the environment. Steps tested on Ubuntu 22.04.

#### 1. Install Node.js 20 and PostgreSQL

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# Verify
node -v   # v20.x.x
psql --version
```

#### 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER ledgerise WITH PASSWORD 'change-me';
CREATE DATABASE ledgerise OWNER ledgerise;
SQL
```

#### 3. Clone and build

```bash
cd /opt
sudo git clone https://github.com/keneohiaeri/ledgerise.git
sudo chown -R $USER:$USER ledgerise
cd ledgerise
npm install
npm run build
```

#### 4. Run migrations

```bash
export DATABASE_URL="postgres://ledgerise:change-me@localhost:5432/ledgerise"
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql
```

#### 5. Create a systemd service for the API

Create `/etc/systemd/system/ledgerise-api.service`:

```ini
[Unit]
Description=Ledgerise API
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ledgerise
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=on-failure
RestartSec=5

Environment=NODE_ENV=production
Environment=API_PORT=3000
Environment=DATABASE_URL=postgres://ledgerise:change-me@localhost:5432/ledgerise?sslmode=disable
Environment=AUTH_TOKEN_SECRET=REPLACE_WITH_openssl_rand_base64_32
Environment=LEDGERISE_CREDENTIALS_KEY=REPLACE_WITH_openssl_rand_hex_32
Environment=LEDGERISE_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
Environment=LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD=replace-on-first-login

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ledgerise-api
sudo systemctl status ledgerise-api
```

#### 6. Serve the web frontend with nginx

Install nginx and copy the built static files:

```bash
sudo apt-get install -y nginx
sudo cp -r /opt/ledgerise/apps/web/dist /var/www/ledgerise
```

Create `/etc/nginx/sites-available/ledgerise`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Serve the React SPA
    root /var/www/ledgerise;
    index index.html;

    # Proxy /api and /healthcheck to the Node API
    location ~ ^/(api|healthcheck) {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # React Router — serve index.html for all non-file paths
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ledgerise /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### 7. Add TLS with Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot rewrites the nginx config to add HTTPS and auto-renewal.

#### 8. Rebuild and deploy updates

```bash
cd /opt/ledgerise
git pull
npm install
npm run build
# Run any new migrations
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
sudo systemctl restart ledgerise-api
sudo cp -r apps/web/dist /var/www/ledgerise
```

---

### Option B — Render (managed PaaS)

Render handles TLS, deployments, and managed Postgres with no server to manage.

#### 1. Create a Postgres database

Render dashboard → **New → PostgreSQL** → choose a name and plan → **Create Database**.

Copy the **Internal Database URL** shown on the database page.

#### 2. Deploy the API as a Web Service

Render dashboard → **New → Web Service** → connect your GitHub repo.

| Setting | Value |
|---|---|
| Root directory | *(leave blank — monorepo build runs from root)* |
| Runtime | Node |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |

Add environment variables in the Render dashboard:

```
DATABASE_URL                       = <Internal Database URL>
AUTH_TOKEN_SECRET                  = <openssl rand -base64 32>
LEDGERISE_CREDENTIALS_KEY          = <openssl rand -hex 32>
LEDGERISE_BOOTSTRAP_ADMIN_EMAIL    = admin@example.com
LEDGERISE_BOOTSTRAP_ADMIN_PASSWORD = <temporary password>
NODE_ENV                           = production
```

Note the service's public URL — you'll need it for the frontend build (`https://ledgerise-api.onrender.com`).

#### 3. Run migrations (one-time)

From your local machine, using the **External Database URL** from the Render database page:

```bash
export DATABASE_URL="<External Database URL>"
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f infra/seed/0001_local_operator_and_adapters.sql
psql "$DATABASE_URL" -f infra/seed/0002_default_coa.sql
```

For subsequent deploys, add this as a **pre-deploy command** in Render:

```bash
for f in infra/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

#### 4. Deploy the web frontend as a Static Site

Render dashboard → **New → Static Site** → same repo.

| Setting | Value |
|---|---|
| Build command | `npm install && VITE_API_BASE_URL=https://ledgerise-api.onrender.com npm run build -w apps/web` |
| Publish directory | `apps/web/dist` |

Add a rewrite rule so React Router works:

| Source | Destination | Action |
|---|---|---|
| `/*` | `/index.html` | Rewrite |

---

### Option C — Railway

Similar to Render but with a project-based UI that groups services together.

1. Create a new Railway project and add a **PostgreSQL** plugin.
2. Railway detects the `Procfile` automatically. It will start the `web` process (API) and `worker` process separately. You can also set them manually:
   - **Build command**: `npm install && npm run build`
   - **Start command** (API service): `npm start`
   - **Start command** (worker service): `npm run start:worker`
3. Add the same environment variables as in the Render section. Railway injects `DATABASE_URL` automatically from the Postgres plugin.
4. For the frontend, add a third service using Railway's static hosting. Set `VITE_API_BASE_URL` to the API service's Railway domain before the build runs.
5. Run migrations from your local machine the same way as in the Render section.

---

## Health Checks

- `GET /healthcheck` or `GET /api/health`
- Returns `200 {"status":"ok","db":"ok"}` when healthy
- Returns `503 {"status":"error","db":"unavailable"}` if Postgres is unreachable
- Use this as the health check URL in Render, Railway, or your load balancer

---

## First Login

1. Open the dashboard URL in a browser.
2. Log in with the bootstrap admin email and password.
3. You will be prompted to set a new password — do this before anything else.
4. After setting your password you have full admin access.

---

## Production Checklist

- [ ] `AUTH_TOKEN_SECRET` set to a strong random value: `openssl rand -base64 32`
- [ ] `LEDGERISE_CREDENTIALS_KEY` set: `openssl rand -hex 32`
- [ ] `DATABASE_URL` uses SSL: append `?sslmode=require` (or `verify-full` with a CA cert)
- [ ] Bootstrap admin password rotated on first login
- [ ] API served behind TLS (nginx + Certbot on VPS; automatic on Render/Railway)
- [ ] Log output piped to a log aggregator (journald on VPS; Render/Railway have built-in log streams)
- [ ] Health check URL configured in your load balancer or hosting platform
- [ ] Migration pre-deploy step runs before new API versions start
- [ ] `VITE_API_BASE_URL` matches the actual public API URL used for the frontend build

---

## Structured Logs

The API writes newline-delimited JSON to stdout. Each line includes at minimum:

```json
{"timestamp":"2026-06-02T12:00:00.000Z","level":"info","event":"http_request","method":"GET","path":"/api/coa","status":200,"duration_ms":4,"remote_addr":"127.0.0.1"}
```

| Event | Level | Description |
|---|---|---|
| `server_start` | info | API process started |
| `http_request` | info | Every HTTP request (method, path, status, duration_ms) |
| `auth_login` | info | Successful dashboard login |
| `auth_login_failed` | warn | Failed login attempt (no credentials in log) |
| `auth_logout` | info | Dashboard logout |
| `ingest_rate_limit_exceeded` | warn | Source IP exceeded ingest rate limit |
| `health_db_failed` | error | Health check DB probe failed |
| `credentials_decrypt_failed` | error | AES-GCM auth tag mismatch — possible key rotation issue |
| `unhandled_request_error` | error | Unexpected exception in request handler |

On a VPS, logs are captured by journald automatically when using systemd. View them with:

```bash
sudo journalctl -u ledgerise-api -f
```
