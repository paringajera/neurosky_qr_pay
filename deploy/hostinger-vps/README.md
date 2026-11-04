# Deploying NeuroSky Pay on a Hostinger VPS (or any Ubuntu VPS)

This folder contains everything needed to run NeuroSky Pay on a single Ubuntu 22.04 / 24.04 server with
automatic HTTPS: an installer, a systemd service, a Caddy reverse-proxy config, a production `.env`
template, and backup/update scripts.

## Why a VPS and not shared hosting

NeuroSky Pay is not a single web page. It is seven long-running Node.js services (Payment API on 6100,
Checkout Portal on 7000, Merchant Admin on 6001, Control Center on 8090, Gmail and SMS observers on
6003/6002, demo store on 5000) that keep payment timers, Server-Sent Events streams and a SQLite database
alive 24×7. Hostinger's shared and Cloud "Node.js" hosting runs one app per site on a port it assigns,
does not allow custom ports or Docker, stops the process when there is no traffic, limits every request
to 120 seconds, and terminates background workers and timers (see Hostinger's
[Node.js limitations article](https://www.hostinger.com/support/?p=21141) and the
[Node.js overview](https://docs.hostinger.com/node.js/overview)). Payment verification would silently
stop. Use a **Hostinger KVM VPS** (KVM 1 is enough to start) or any Linux VPS instead.

## 1. Buy and prepare the VPS

1. In hPanel buy a **KVM VPS** and pick the plain **Ubuntu 24.04** OS template. Do not pick a template
   with a control panel (CloudPanel, CyberPanel, Plesk): they occupy ports 80/443 which Caddy needs.
2. Note the VPS IP address and set a root password / SSH key in hPanel → VPS → Settings.
3. hPanel → VPS → Firewall: allow TCP **22**, **80**, **443** (the installer also configures `ufw` on the box).

## 2. Point your domain

Create **A records** in your DNS zone (hPanel → Domains → DNS / Nameservers, or Cloudflare if the domain
is there) pointing at the VPS IP. With base domain `example.com` and the default prefix `pay`:

| Record (A)             | Serves                                   | Port |
| :--------------------- | :--------------------------------------- | :--- |
| `pay.example.com`      | Checkout portal, `neurosky.js`, QR stand | 7000 |
| `pay-api.example.com`  | Payment API, webhooks, observers         | 6100 |
| `pay-admin.example.com`| Merchant Admin                           | 6001 |
| `pay-gmail.example.com`| Gmail OAuth callback                     | 6003 |
| `pay-store.example.com`| Demo store (optional)                    | 5000 |

Wait until `ping pay.example.com` answers with the VPS IP. Caddy requests Let's Encrypt certificates
automatically as soon as the names resolve.

## 3. Install

SSH into the VPS as root and run:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/paringajera/neurosky_qr_pay.git /opt/neurosky-pay
bash /opt/neurosky-pay/deploy/hostinger-vps/install.sh example.com pay https://shop.example.com
```

Arguments: `<base-domain> [prefix] [merchant-site-origin]`. The third argument is the origin of the
website that will embed the checkout (where you add the `<script src=".../neurosky.js">` tag). Leave it
out to start with the demo store only.

If the GitHub repository is private, clone with a personal access token
(`git clone https://<TOKEN>@github.com/paringajera/neurosky_qr_pay.git /opt/neurosky-pay`) or upload the
project folder to `/opt/neurosky-pay` with SFTP; the installer uses whatever is already in that folder.

The installer (idempotent, safe to re-run):

- installs Node.js 24 LTS, Caddy, git, sqlite3, ufw;
- creates the system user `neurosky` and installs dependencies with `npm ci`;
- renders `/opt/neurosky-pay/.env` from `env.production.template` with freshly generated
  `ENCRYPTION_MASTER_KEY`, `JWT_SECRET` and `ADMIN_API_TOKEN` (never printed; an existing `.env` is kept);
- installs and starts the `neurosky-pay` systemd service (`npm start`, restarts on crash and on reboot);
- installs `/etc/caddy/Caddyfile` and reloads Caddy;
- opens only ports 22/80/443 in `ufw` and schedules a nightly database backup at 02:15.

**Keep the credentials you already use.** If you want the server to use the same admin token, Android
enrollment secret and Gmail OAuth client as the `.env` on your workstation, copy that file to the server
(for example `scp .env root@<vps-ip>:/root/workstation.env`) and pass it to the installer:

```bash
SEED_ENV_FILE=/root/workstation.env bash /opt/neurosky-pay/deploy/hostinger-vps/install.sh example.com pay
```

Only credential keys are copied (`ADMIN_API_TOKEN`, `ANDROID_ENROLLMENT_SECRET`, `OBSERVER_API_TOKEN`,
`ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`); URLs, ports and mode stay
production values. The same can be done later with
`bash deploy/hostinger-vps/apply-env-credentials.sh /root/workstation.env` followed by a restart.
Never commit `.env` to git to move it: the server would pull a localhost configuration over its own.

## 4. First login and configuration

1. Read the admin token on the server and keep it somewhere safe:
   ```bash
   grep '^ADMIN_API_TOKEN=' /opt/neurosky-pay/.env
   ```
2. Open `https://pay-admin.example.com`, paste the token in the unlock box. The header badge must read
   **PRODUCTION** with your domain. If it says LOCALHOST, open **Developer & Infrastructure Hub → Environment**,
   enter the base domain and prefix and select **Production Mode** before saving anything else, otherwise the
   first save stores localhost URLs for checkout links and the Android pairing QR.
3. **Store Settings → Receiving Accounts**: add your UPI ID (VPA) and activate it.
4. Put that account's ID into `.env` so the Gmail observer can start, then restart:
   ```bash
   nano /opt/neurosky-pay/.env        # RECEIVING_ACCOUNT_ID=<id shown in the dashboard>
   systemctl restart neurosky-pay
   ```
5. **Gmail observer**: in Google Cloud Console add `https://pay-gmail.example.com/oauth/callback` as an
   authorized redirect URI, then use Developer Hub → Gmail → Connect with Google
   (see `docs/google_cloud_console_setup_guide.md`).
6. **Android SMS gateway**: Developer Hub → Android SMS Hub → download the APK, install it on the phone
   that receives the bank SMS, scan the pairing QR. The APK talks to `https://pay-api.example.com`.
   Before the first real payment, paste one of your bank's credit SMS into the **Test Bank SMS Parser**
   box on the same page: it dry-runs the phone filter and the server parser without recording anything.
7. **Merchant site**: add the script tag shown in Store Settings → Brand Identity, create payments
   server-side with your merchant key (`X-Merchant-Key`), and fulfil orders only on the `RECONCILED`
   webhook (`docs/MERCHANT_INTEGRATION.md`). Every storefront origin must be listed in
   `NEUROSKY_ALLOWED_ORIGINS`, `NEUROSKY_ALLOWED_RETURN_ORIGINS` and `CHECKOUT_FRAME_ANCESTORS` in `.env`.

## 5. Day-to-day operation

| Task                      | Command |
| :------------------------ | :------ |
| Status                    | `systemctl status neurosky-pay` |
| Live logs                 | `journalctl -u neurosky-pay -f` |
| Restart                   | `systemctl restart neurosky-pay` |
| Health checks             | `curl http://127.0.0.1:6100/health` (and 7000, 6001, 6003, 5000, 8090) |
| Update to latest code     | `bash /opt/neurosky-pay/deploy/hostinger-vps/update.sh` |
| Manual backup             | `APP_DIR=/opt/neurosky-pay bash /opt/neurosky-pay/deploy/hostinger-vps/backup.sh` |
| Reuse workstation credentials | `bash /opt/neurosky-pay/deploy/hostinger-vps/apply-env-credentials.sh /root/workstation.env && systemctl restart neurosky-pay` |
| Backups                   | `/opt/neurosky-pay/backups/` (nightly, 14 days kept) |
| Restore a backup          | stop the service, `gunzip -c backups/<file>.gz > data/neurosky_pay.sqlite`, delete `data/neurosky_pay.sqlite-wal` and `-shm`, start the service |
| Caddy / certificate logs  | `journalctl -u caddy -f` |

## 6. Security notes

- Only Caddy is reachable from the internet; every Node service binds `127.0.0.1`. Do not set
  `NEUROSKY_BIND_HOST` and do not publish ports 8090 (Control Center) or 6002 (SMS observer).
- `/opt/neurosky-pay/.env` and `/opt/neurosky-pay/data/.secrets/` hold the keys. They are `chmod 600`,
  excluded from git, and must be included in your off-server backups.
- Rotating `ENCRYPTION_MASTER_KEY` makes stored Gmail OAuth credentials unreadable; keep it stable.
- Keep `NEUROSKY_EXPOSE_DEV_OTP` and `NEUROSKY_ALLOW_DEV_TOOLS` unset in production. The developer
  payment simulator refuses to run without them, which is what you want on a live gateway.
- Merchant API keys and the webhook secret stay on the merchant's server. Never put them in HTML or JS.
- This project is still the experimental gateway described in the root README: respect the usage
  limits and the "fulfil only on RECONCILED" rule, and reconcile against your bank statement.

## 7. Troubleshooting

| Symptom | Check |
| :------ | :---- |
| `install.sh` ends with "did not come up in 60s" | `journalctl -u neurosky-pay -n 100 --no-pager`; the usual causes are a missing domain argument or an npm install failure |
| Browser shows a Caddy certificate error | DNS is not pointing at the VPS yet, or port 80/443 is blocked in the hPanel firewall; `journalctl -u caddy -n 50` |
| Dashboard says "Origin is not allowed" on save | the admin origin must be in `NEUROSKY_ALLOWED_ORIGINS` (the template includes it); restart after editing `.env` |
| Gmail observer stays STANDBY | `RECEIVING_ACCOUNT_ID` not set, or the redirect URI in Google Cloud does not match exactly |
| Android app cannot pair | the phone must reach `https://pay-api.example.com`; HTTP without TLS is blocked by the app |
| Checkout works but the merchant site cannot open the modal | add the storefront origin to `CHECKOUT_FRAME_ANCESTORS` and `NEUROSKY_ALLOWED_ORIGINS` |
| Saving settings fails with "Webhook URL must not point to a loopback or private network address" | the merchant webhook URL is still `http://localhost:5000/api/webhook` (databases seeded before `COIN_STORE_WEBHOOK_URL` was in the template). Set it to `https://pay-store.example.com/api/webhook` in Developer Hub → Webhooks & Secrets, or set `NEUROSKY_ALLOW_PRIVATE_WEBHOOKS=true` in `.env` and restart |
| Header badge says LOCALHOST, checkout links or the pairing QR point at localhost | Developer Hub → Environment: enter the base domain and prefix and select Production Mode, then save again |
