# Deploy Seabyss Web API on OVH

This guide prepares a separate web API service for the public website. It does not modify the game service `seabyss-beta`.

Recommended public API domain:

```txt
https://api.seabyss.com
```

## 1. Server directory

On the OVH server, create a dedicated folder:

```bash
sudo mkdir -p /opt/seabyss/web-api
sudo chown -R seabyss:seabyss /opt/seabyss/web-api
```

Copy only the `server-web-api` application files into `/opt/seabyss/web-api`.

From Windows PowerShell, copy the backend files without `.git`, `.env`, or `node_modules`:

```powershell
$repo = "C:\KRUEGER\Main Folder\Seabyss II (Nouveau Chapitre)\Seabyss-Website"
$sshKey = "$HOME\.ssh\seabyss_ovh"
scp -i $sshKey -r "$repo\server-web-api\package.json" "$repo\server-web-api\src" "$repo\server-web-api\.env.example" seabyss@54.37.128.14:/opt/seabyss/web-api/
scp -i $sshKey "$repo\deploy\seabyss-web-api.service.example" seabyss@54.37.128.14:/tmp/seabyss-web-api.service
scp -i $sshKey "$repo\deploy\nginx-api.seabyss.com.conf.example" seabyss@54.37.128.14:/tmp/api.seabyss.com.conf
```

Then on OVH, install the service and Nginx config from `/tmp` with `sudo` as shown below.

## 2. Install Node.js if needed

Check Node.js:

```bash
node --version
npm --version
```

If Node.js 20 or newer is not installed, install a current LTS release before deploying the API. One common Ubuntu option is NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then confirm:

```bash
node --version
npm --version
```

## 3. Install dependencies

```bash
cd /opt/seabyss/web-api
npm install --omit=dev
```

If a `package-lock.json` is committed later, prefer:

```bash
npm ci --omit=dev
```

## 4. Install and start Redis

Redis stores only the web sessions for `seabyss-web-api`. It is separate from the game service `seabyss-beta`.

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
sudo systemctl status redis-server --no-pager
redis-cli ping
```

Expected Redis ping response:

```txt
PONG
```

Keep Redis local to the server unless there is a reviewed reason to expose it. Do not open Redis publicly on the internet.

## 5. Create server-only `.env`

Create `/opt/seabyss/web-api/.env` directly on the server:

```txt
NODE_ENV=production
PORT=3000
PUBLIC_SITE_ORIGIN=https://www.seabyss.com,https://seabyss.com
PLAYFAB_TITLE_ID=xxxxx
PLAYFAB_SECRET_KEY=xxxxx
SESSION_SECRET=long_random_secret
COOKIE_DOMAIN=.seabyss.com
SEABYSS_ENV=beta
REDIS_URL=redis://127.0.0.1:6379
SESSION_TTL_SECONDS=86400
```

Do not commit this file and do not copy real values into the GitHub Pages repository.

## 6. systemd service

Install the example service as:

```txt
/etc/systemd/system/seabyss-web-api.service
```

The service example declares `redis-server.service` as a dependency. It does not replace or modify `seabyss-beta`.

If you copied the example to `/tmp`:

```bash
sudo cp /tmp/seabyss-web-api.service /etc/systemd/system/seabyss-web-api.service
sudo chown root:root /etc/systemd/system/seabyss-web-api.service
sudo chmod 644 /etc/systemd/system/seabyss-web-api.service
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable seabyss-web-api
sudo systemctl restart redis-server
sudo systemctl start seabyss-web-api
sudo systemctl status seabyss-web-api
```

Logs:

```bash
sudo journalctl -u seabyss-web-api -f
```

Restart after updating `.env` or deploying a new build:

```bash
sudo systemctl restart seabyss-web-api
sudo systemctl status seabyss-web-api --no-pager
```

## 7. Nginx reverse proxy

Create an Nginx server block for:

```txt
api.seabyss.com
```

It should proxy to:

```txt
http://127.0.0.1:3000
```

If you copied the example to `/tmp`:

```bash
sudo cp /tmp/api.seabyss.com.conf /etc/nginx/sites-available/api.seabyss.com
sudo ln -sfn /etc/nginx/sites-available/api.seabyss.com /etc/nginx/sites-enabled/api.seabyss.com
```

Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. HTTPS

Use Certbot for `api.seabyss.com`:

```bash
sudo certbot --nginx -d api.seabyss.com
```

The website login flow should be used only over HTTPS in production.

## 9. Production checks

- `GET https://api.seabyss.com/health`
- Bad `POST /auth/login` returns a generic error.
- Good `POST /auth/login` creates an HttpOnly Secure SameSite cookie.
- `GET /auth/session` returns `loggedIn`.
- `GET /me` returns sanitized profile data only.
- `POST /auth/logout` clears the session cookie.
- Restart `seabyss-web-api`, then verify the same browser session still works.
- `POST /auth/logout`, then verify `GET /me` returns `401`.
- Stop Redis in a staging window and confirm production API startup fails clearly instead of silently using MemoryStore.
- CORS rejects unknown origins.
- Login rate limit triggers after repeated attempts.
- Logs do not contain passwords, PlayFab SessionTickets, or private keys.

## Launch limitations to audit

- Review Redis persistence, memory limits, backup policy, and operational monitoring before official launch.
- Review PlayFab profile and inventory reads before exposing more data.
- Add account recovery and account creation only through reviewed flows.
- Keep Market disabled until payments are implemented through a secured backend and official provider verification.
- Run a security review before treating the site as official launch ready.
