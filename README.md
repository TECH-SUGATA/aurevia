# 🪴 Aurevia: AI Plant Therapist

> Developed by **Sugata Nayak**, AI Engineer & Full-Stack Developer

Anyone can use Aurevia: **create an account, connect your own Raspberry Pi with one command, and watch and water your plant from any phone, tablet or PC.**

**Live demo:** https://aurevia-swart-mu.vercel.app

```
Raspberry Pi (your sensors + pump)          Aurevia server (Render)               Your phone / PC
┌─────────────────────────────┐   readings  ┌─────────────────────────┐  web   ┌──────────────┐
│ pi/aurevia_pi.py            │ ──────────▶ │ accounts · health score │ ◀───── │ installable  │
│ moisture · pH · temperature │ ◀────────── │ AI scan · auto-watering │ ─────▶ │ web app (PWA)│
│ pump relay                  │  pump order │ rules                   │        └──────────────┘
└─────────────────────────────┘             └───────────┬─────────────┘         (served by Vercel,
                                                        │                        /api forwarded to Render)
                                                        ▼
                                             ┌─────────────────────────┐
                                             │ Turso (libSQL) database │
                                             └─────────────────────────┘
```

| Folder | What it is |
| --- | --- |
| `server/` | Node.js + Express API and the web app (`server/public/index.html`, plain HTML/CSS/JS). Data is stored in **Turso** (libSQL). |
| `pi/` | Python client + one-line installer that every user runs on their Pi |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Deploy the server with Docker (used by Render, or your own VPS with automatic HTTPS) |
| `vercel.json` | Serves the web app from Vercel and forwards `/api/*` to the Render server |

---

## A. For you (the owner): put the server online once

### 1. Create the Turso database

```bash
# install the Turso CLI, then:
turso auth login
turso db create aurevia
turso db show aurevia --url            # -> libsql://aurevia-yourname.turso.io
turso db tokens create aurevia         # -> your auth token (keep it secret)
```

The server creates all tables automatically on first start. You do not need to run any SQL by hand.

### 2. Deploy the server on Render

1. Create a **Web Service** on [Render](https://render.com) from this GitHub repo. Runtime: **Docker** (uses the `Dockerfile`).
2. In **Environment**, add:

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://aurevia-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | the token from `turso db tokens create` |
| `TRUST_PROXY` | `1` |
| `GITHUB_REPO` | `owner/aurevia` (shows users the correct Pi install command) |
| `INVITE_CODE` | *(recommended)* sign-up needs this code, so strangers can't use your AI credits |
| `ANTHROPIC_API_KEY` | *(optional)* turns on real leaf diagnosis and chat |
| `AI_DAILY_LIMIT` | *(optional)* AI requests per user per day, default `30` |

3. Deploy. In the Render **Logs** you should see:
   ```
   Aurevia DB: using Turso
   Aurevia server running on ...
   ```
   If it says `using local file`, the Turso variables are missing.

> Never commit your real `TURSO_AUTH_TOKEN`. Keep it only in Render's environment (and a local `.env`, which is git-ignored). If it ever leaks, create a new one with `turso db tokens create` and delete the old one.

### 3. Deploy the web app on Vercel

`vercel.json` serves `server/public` and forwards every `/api/*` request to your Render URL. Change the `destination` in `vercel.json` to your own Render service address, then import the repo into Vercel. The database variables are **not** needed on Vercel; only Render talks to Turso.

> The free Render plan sleeps after inactivity, so the first request can take about 50 seconds. A Pi sending readings keeps it awake.

### 4. Alternative: your own VPS

```bash
git clone https://github.com/OWNER/aurevia.git && cd aurevia
cp .env.example .env      # set DOMAIN, GITHUB_REPO, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, INVITE_CODE
docker compose up -d --build
```

Caddy gets the HTTPS certificate automatically, which also makes the app installable on phones.

### 5. Run locally

```bash
cd server && npm install
# with Turso:
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm start
# or without Turso (uses a local SQLite file, DB_FILE=./data/aurevia.db):
npm start
```

Open `http://localhost:3001`.

### Check that data is reaching Turso

Create an account in the app, then:

```bash
turso db shell aurevia "SELECT id, email, created_at FROM users;"
turso db shell aurevia ".tables"
```

You can also open the Turso dashboard → your database → **Edit Data**.

---

## B. For every user: connect your Raspberry Pi

1. Create an account in the app (**Log in → New here? Create an account**).
2. Wire your sensors (see the table below) and run on the Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/aurevia/main/pi/install.sh | AUREVIA_REPO=https://github.com/OWNER/aurevia.git AUREVIA_SERVER=https://your-domain bash
```

The **Me** tab in the app shows this exact command with the server address filled in.

3. The Pi prints a **pairing code** (also in `journalctl -u aurevia-pi -f`).
4. In the app open **Me → Connect device**, type the code, and name your plant. Done: readings appear within seconds.

No sensors yet? Try it first: `AUREVIA_SERVER=https://your-domain python3 pi/aurevia_pi.py --simulate`.

To disconnect a Pi, use **Remove** in the app; the Pi then asks for a new code.

### Hardware and wiring

Raspberry Pi 3/4/5 or Zero 2 W, plus:

| Part | Purpose |
| --- | --- |
| ADS1115 ADC module | The Pi has no analog inputs; this reads moisture and pH |
| Capacitive soil moisture sensor v1.2 | Soil moisture |
| pH probe + module (e.g. PH-4502C) | Soil pH |
| DS18B20 temperature sensor + 4.7 kΩ resistor | Temperature |
| 5 V relay module, small pump, tubing, tank | Watering |
| Separate 5 V supply for the pump | Never power the pump from the Pi pins |

| From | To |
| --- | --- |
| ADS1115 VDD / GND | Pi 3.3 V (pin 1) / GND (pin 6) |
| ADS1115 SDA / SCL | Pi pin 3 / pin 5 |
| Moisture sensor signal | ADS1115 A0 (power from 3.3 V) |
| pH module signal | ADS1115 A1 (keep it under the ADS1115 supply voltage; use a voltage divider if the module outputs up to 5 V) |
| DS18B20 data | Pi pin 7 (GPIO4), 4.7 kΩ resistor between data and 3.3 V |
| Relay IN | Pi pin 11 (GPIO17); relay VCC to 5 V, GND to GND |
| Pump | Through the relay COM / NO terminals, with its own supply |

After the first install, reboot once so I2C and 1-Wire are active. Check: `i2cdetect -y 1` shows `48`, and `ls /sys/bus/w1/devices` lists a `28-…` folder.

**Calibrate** by editing `~/.aurevia/aurevia.env` (then `sudo systemctl restart aurevia-pi`):

- `MOIST_DRY_V` / `MOIST_WET_V`: sensor voltage in open air / in a glass of water.
- `PH_V7` / `PH_V4`: voltage in pH 7.00 / pH 4.00 buffer solution.
- `ML_PER_SEC`: time the pump filling a measuring cup.

Test the pump with an empty tube first. A watering is capped at 60 s on the Pi, and the server waits 30 minutes between automatic waterings.

---

## How watering works

Every 10 seconds the Pi sends a reading. The reply can say "run the pump for N ml": either because moisture is below the plant's threshold (auto-water) or because the user tapped **Water now** (queued until the next reading). Watering is only logged when the order is delivered.

## Security and limits (please read)

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies, and cross-site writes are refused. Every plant, reading and device is scoped to its owner.
- Each Pi has its own secret token, stored only as a hash on the server. Pairing codes are single-use and expire after 1 hour.
- **Not included yet:** email verification and password reset (they need an email service), and an admin panel. Keep `INVITE_CODE` set if you don't want open sign-up.
- Data lives in a **Turso (libSQL)** database, so it survives redeploys and restarts of the server. The Turso free plan has monthly row read/write limits; a Pi reporting every 10 seconds writes about 8,600 readings per day per device, so watch your usage as you add devices.
- Photos sent for diagnosis go to the AI provider only when you set `ANTHROPIC_API_KEY`. Photos aren't stored on the server. Tell your users.
- This is a hobby and learning project, not a safety system. Don't rely on it for plants you can't afford to lose.

## Develop

```bash
cd server && npm install && npm test     # accounts, pairing, watering, user isolation
npm start                                # http://localhost:3001
python3 ../pi/aurevia_pi.py --simulate   # with AUREVIA_SERVER=http://localhost:3001
```

Tests use an in-memory local database and never touch Turso.

Developer details: search `DEVS` in `server/public/index.html`. Empty fields are simply not shown, so fill in only what you want public.

## Author

**Sugata Nayak**: AI Engineer | Full-Stack Developer | Open-Source Contributor, Kolkata, India

- GitHub: [TECH-SUGATA](https://github.com/TECH-SUGATA)
- LinkedIn: [sugata-nayak](https://www.linkedin.com/in/sugata-nayak-343099322/)
- Portfolio: [tech-sugata.github.io/PORTFOLIO](https://tech-sugata.github.io/PORTFOLIO/#contact)
- Email: sugatanayak65@gmail.com

### Tips to get Aurevia noticed

- Add 3-4 screenshots and a short screen recording (or a GIF) at the top of this README.
- Add topics to the repository such as `raspberry-pi`, `iot`, `ai`, `plant-care`, `pwa`, `nodejs`, `turso`.
- Pin the repository on your GitHub profile and share a short build story on LinkedIn (problem, hardware photo, demo video).

## License

MIT
