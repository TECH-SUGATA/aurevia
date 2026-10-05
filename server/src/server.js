import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { summary, RANGES } from './health.js';
import { diagnoseLeaf, chatAdvice, aiEnabled } from './ai.js';

const WATER_ML = 200, TANK_COST = 6, COOLDOWN_MIN = 30, SESSION_DAYS = 30, ONLINE_SEC = 120;
const MAX_DEVICES = 5, MAX_PLANTS = 10;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = () => crypto.randomBytes(32).toString('base64url');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join('');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Express 4 does not catch errors from async handlers, so wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(':');
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='))?.slice(name.length + 1);

function limiter(max, windowMs, keyFn) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), k = keyFn(req), arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return bad(res, 'Too many requests. Please wait and try again.', 429);
    arr.push(now); hits.set(k, arr);
    if (hits.size > 5000) for (const [key, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(key);
    next();
  };
}

// NOTE: db must already be opened:  createApp(await openDb())
export function createApp(db) {
  if (!db) throw new Error('createApp(db) needs an opened database: createApp(await openDb())');
  const app = express();
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '8mb' }));

  // Browsers always send Origin on cross-site writes; refuse any that is not this site.
  app.use('/api', (req, res, next) => {
    const o = req.get('origin');
    if (req.method !== 'GET' && o) { try { if (new URL(o).host !== ((process.env.TRUST_PROXY === '1' && req.get('x-forwarded-host')) || req.get('host')).split(',')[0].trim()) return bad(res, 'Cross-site request blocked', 403); } catch { return bad(res, 'Bad origin', 403); } }
    next();
  });

  const requireUser = ah(async (req, res, next) => {
    const t = getCookie(req, 'aurevia_session');
    const row = t && await db.prepare("SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')").get(sha(t));
    if (!row) return bad(res, 'Please log in', 401);
    req.user = row; next();
  });
  const requireDevice = ah(async (req, res, next) => {
    const t = (req.get('authorization') || '').replace(/^Bearer /, '');
    const d = t && await db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha(t));
    if (!d) return bad(res, 'Unknown device. Pair it again.', 401);
    req.device = d; next();
  });
  const withPlant = ah(async (req, res, next) => {
    const p = await db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!p) return bad(res, 'Plant not found', 404);
    req.plant = p; next();
  });
  const latest = (id) => db.prepare('SELECT moisture, temperature, ph, created_at FROM readings WHERE plant_id = ? ORDER BY id DESC LIMIT 1').get(id);
  const lastSeen = async (plantId) => (await db.prepare('SELECT MAX(last_seen) AS t FROM devices WHERE plant_id = ?').get(plantId))?.t || null;
  const isOnline = (t) => Boolean(t) && Date.now() - new Date(t.replace(' ', 'T') + 'Z').getTime() < ONLINE_SEC * 1000;
  const present = async (p) => {
    const r = await latest(p.id), seen = await lastSeen(p.id);
    const { pending_ml, ...rest } = p;
    return { ...rest, auto_water: Boolean(p.auto_water), latest: r || null, health: r ? summary(r) : null, last_seen: seen, device_online: isOnline(seen) };
  };
  async function ensureCode(d) {
    const now = (await db.prepare("SELECT datetime('now') AS n").get()).n;
    const fresh = d.pairing_code && d.pairing_expires > now;
    if (fresh) return d.pairing_code;
    const code = newCode();
    await db.prepare("UPDATE devices SET pairing_code = ?, pairing_expires = datetime('now','+1 hour') WHERE id = ?").run(code, d.id);
    return code;
  }
  async function setSession(req, res, userId) {
    const token = rand();
    await db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).run(sha(token), userId);
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `aurevia_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  // Store a reading and decide whether the pump should run (manual request first, then the auto rule).
  async function ingest(plant, r) {
    await db.prepare('INSERT INTO readings (plant_id, moisture, temperature, ph) VALUES (?,?,?,?)').run(plant.id, r.moisture, r.temperature, r.ph);
    let pump = { run: false, ml: 0 };
    const water = async (source, ml) => {
      await db.prepare('INSERT INTO watering_events (plant_id, source, amount_ml) VALUES (?,?,?)').run(plant.id, source, ml);
      await db.prepare('UPDATE plants SET tank_percent = MAX(0, tank_percent - ?), pending_ml = 0 WHERE id = ?').run(TANK_COST, plant.id);
      pump = { run: true, ml };
    };
    if (plant.pending_ml > 0) {
      if (plant.tank_percent >= 5) await water('manual', plant.pending_ml);
      else await db.prepare('UPDATE plants SET pending_ml = 0 WHERE id = ?').run(plant.id);
    } else if (plant.auto_water && r.moisture < plant.water_below && plant.tank_percent >= 5) {
      const recent = await db.prepare("SELECT 1 FROM watering_events WHERE plant_id = ? AND created_at > datetime('now', ?) LIMIT 1").get(plant.id, `-${COOLDOWN_MIN} minutes`);
      if (!recent) await water('auto', WATER_ML);
    }
    return { health: summary(r), pump };
  }
  const validReading = (b) => {
    const { moisture, temperature, ph } = b || {};
    if ([moisture, temperature, ph].some((v) => num(v) === null)) return null;
    if (moisture < 0 || moisture > 100 || temperature < -20 || temperature > 70 || ph < 0 || ph > 14) return null;
    return { moisture, temperature, ph };
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiEnabled(), invite_required: Boolean(process.env.INVITE_CODE), repo: process.env.GITHUB_REPO || null, ranges: RANGES }));

  // ---- Accounts ----
  const byIp = (req) => req.ip;
  app.post('/api/auth/signup', limiter(10, 3600e3, byIp), ah(async (req, res) => {
    const { email, password, invite } = req.body || {};
    const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 120) return bad(res, 'Enter a valid email address');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return bad(res, 'Password must be at least 8 characters');
    if (process.env.INVITE_CODE && invite !== process.env.INVITE_CODE) return bad(res, 'Invalid invite code', 403);
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) return bad(res, 'That email is already registered', 409);
    const id = (await db.prepare('INSERT INTO users (email, pass_hash) VALUES (?, ?)').run(e, hashPw(password))).lastInsertRowid;
    await setSession(req, res, id);
    res.status(201).json({ user: { id, email: e } });
  }));

  app.post('/api/auth/login', limiter(10, 60e3, byIp), ah(async (req, res) => {
    const { email, password } = req.body || {};
    const u = typeof email === 'string' && await db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!u || typeof password !== 'string' || !checkPw(password, u.pass_hash)) return bad(res, 'Wrong email or password', 401);
    await setSession(req, res, u.id);
    res.json({ user: { id: u.id, email: u.email } });
  }));

  app.post('/api/auth/logout', ah(async (req, res) => {
    const t = getCookie(req, 'aurevia_session');
    if (t) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
    res.set('Set-Cookie', 'aurevia_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.status(204).end();
  }));

  app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

  // ---- Raspberry Pi (device) endpoints ----
  app.post('/api/device/register', limiter(20, 3600e3, byIp), ah(async (_req, res) => {
    const token = rand(), code = newCode();
    await db.prepare("INSERT INTO devices (token_hash, pairing_code, pairing_expires) VALUES (?, ?, datetime('now','+1 hour'))").run(sha(token), code);
    res.status(201).json({ device_token: token, pairing_code: code, expires_in_minutes: 60 });
  }));

  app.post('/api/device/readings', requireDevice, ah(async (req, res) => {
    const d = req.device;
    await db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(d.id);
    if (!d.user_id) return res.json({ claimed: false, pairing_code: await ensureCode(d) });
    const r = validReading(req.body);
    if (!r) return bad(res, 'moisture, temperature and ph must be numbers in a physical range');
    const plant = await db.prepare('SELECT * FROM plants WHERE id = ?').get(d.plant_id);
    if (!plant) return bad(res, 'Plant was deleted. Remove and pair the device again.', 410);
    res.status(201).json({ claimed: true, ...(await ingest(plant, r)) });
  }));

  // ---- Devices (user side) ----
  app.post('/api/devices/claim', requireUser, limiter(10, 60e3, (r) => r.user.id), ah(async (req, res) => {
    const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const d = code.length === 8 && await db.prepare("SELECT * FROM devices WHERE pairing_code = ? AND user_id IS NULL AND pairing_expires > datetime('now')").get(code);
    if (!d) return bad(res, 'Code not found or expired. Check the code shown on your Pi.', 404);
    if ((await db.prepare('SELECT COUNT(*) c FROM devices WHERE user_id = ?').get(req.user.id)).c >= MAX_DEVICES) return bad(res, `Device limit reached (${MAX_DEVICES})`, 409);
    if ((await db.prepare('SELECT COUNT(*) c FROM plants WHERE user_id = ?').get(req.user.id)).c >= MAX_PLANTS) return bad(res, `Plant limit reached (${MAX_PLANTS})`, 409);
    const name = String(req.body?.plant_name || 'My plant').trim().slice(0, 60) || 'My plant';
    const pid = (await db.prepare('INSERT INTO plants (user_id, name) VALUES (?, ?)').run(req.user.id, name)).lastInsertRowid;
    await db.prepare('UPDATE devices SET user_id = ?, plant_id = ?, pairing_code = NULL, pairing_expires = NULL WHERE id = ?').run(req.user.id, pid, d.id);
    res.status(201).json({ device_id: d.id, plant_id: pid });
  }));

  app.get('/api/devices', requireUser, ah(async (req, res) => {
    const rows = await db.prepare('SELECT d.id, d.last_seen, d.created_at, p.id AS plant_id, p.name AS plant_name FROM devices d LEFT JOIN plants p ON p.id = d.plant_id WHERE d.user_id = ? ORDER BY d.id').all(req.user.id);
    res.json(rows.map((d) => ({ ...d, online: isOnline(d.last_seen) })));
  }));

  app.delete('/api/devices/:id', requireUser, ah(async (req, res) => {
    const r = await db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    return r.changes ? res.status(204).end() : bad(res, 'Device not found', 404);
  }));

  // ---- Plants (always scoped to the logged-in user) ----
  app.get('/api/plants', requireUser, ah(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM plants WHERE user_id = ? ORDER BY id').all(req.user.id);
    res.json(await Promise.all(rows.map(present)));
  }));
  app.get('/api/plants/:id', requireUser, withPlant, ah(async (req, res) => res.json(await present(req.plant))));

  app.put('/api/plants/:id/settings', requireUser, withPlant, ah(async (req, res) => {
    const { auto_water, water_below, name } = req.body || {};
    if (auto_water !== undefined && typeof auto_water !== 'boolean') return bad(res, 'auto_water must be true or false');
    if (water_below !== undefined && !(num(water_below) !== null && water_below >= 10 && water_below <= 60)) return bad(res, 'water_below must be a number between 10 and 60');
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 60)) return bad(res, 'name must be 1-60 characters');
    await db.prepare('UPDATE plants SET auto_water = ?, water_below = ?, name = ? WHERE id = ?').run(
      auto_water === undefined ? req.plant.auto_water : Number(auto_water), water_below ?? req.plant.water_below, name?.trim() ?? req.plant.name, req.plant.id);
    res.json(await present(await db.prepare('SELECT * FROM plants WHERE id = ?').get(req.plant.id)));
  }));

  app.delete('/api/plants/:id', requireUser, withPlant, ah(async (req, res) => {
    await db.prepare('DELETE FROM devices WHERE plant_id = ?').run(req.plant.id);
    await db.prepare('DELETE FROM plants WHERE id = ?').run(req.plant.id);
    res.status(204).end();
  }));

  app.get('/api/plants/:id/readings', requireUser, withPlant, ah(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500);
    res.json((await db.prepare('SELECT moisture, temperature, ph, created_at FROM readings WHERE plant_id = ? ORDER BY id DESC LIMIT ?').all(req.plant.id, limit)).reverse());
  }));

  // Manual watering is queued; the Pi receives it in the reply to its next reading.
  app.post('/api/plants/:id/water', requireUser, withPlant, ah(async (req, res) => {
    if (req.plant.tank_percent < 5) return bad(res, 'Water tank is empty. Refill it and tap Refill.', 409);
    await db.prepare('UPDATE plants SET pending_ml = ? WHERE id = ?').run(WATER_ML, req.plant.id);
    res.status(202).json({ queued: true, device_online: isOnline(await lastSeen(req.plant.id)) });
  }));

  app.post('/api/plants/:id/refill', requireUser, withPlant, ah(async (req, res) => {
    await db.prepare('UPDATE plants SET tank_percent = 100 WHERE id = ?').run(req.plant.id);
    res.json({ tank_percent: 100 });
  }));

  app.get('/api/plants/:id/watering', requireUser, withPlant, ah(async (req, res) => {
    res.json(await db.prepare('SELECT source, amount_ml, created_at FROM watering_events WHERE plant_id = ? ORDER BY id DESC LIMIT 50').all(req.plant.id));
  }));

  // ---- AI (login required, per-user limits to protect your API credits) ----
  const aiMinute = limiter(10, 60e3, (r) => 'u' + r.user.id);
  const daily = new Map();
  const aiDaily = (req, res, next) => {
    const cap = Number(process.env.AI_DAILY_LIMIT || 30), day = new Date().toISOString().slice(0, 10), k = req.user.id;
    const e = daily.get(k)?.day === day ? daily.get(k) : { day, n: 0 };
    if (e.n >= cap) return bad(res, 'Daily AI limit reached. Try again tomorrow.', 429);
    e.n++; daily.set(k, e); next();
  };
  const ownedPlant = async (req) => (req.body?.plant_id ? await db.prepare('SELECT * FROM plants WHERE id = ? AND user_id = ?').get(Number(req.body.plant_id), req.user.id) : null);

  app.post('/api/scan', requireUser, aiMinute, aiDaily, async (req, res) => {
    const { image_base64, media_type } = req.body || {};
    if (typeof image_base64 !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(media_type)) return bad(res, 'image_base64 and media_type (jpeg/png/webp) are required');
    try {
      const plant = await ownedPlant(req);
      const r = await diagnoseLeaf({ image_base64, media_type, plant });
      await db.prepare('INSERT INTO scans (user_id, plant_id, diagnosis, confidence, advice, severity) VALUES (?,?,?,?,?,?)').run(req.user.id, plant?.id ?? null, String(r.diagnosis), num(r.confidence), String(r.advice ?? ''), String(r.severity ?? ''));
      res.json(r);
    } catch (e) { console.error(e); bad(res, 'Diagnosis failed. Please try again.', 502); }
  });

  app.post('/api/chat', requireUser, aiMinute, aiDaily, async (req, res) => {
    const { question, history } = req.body || {};
    if (typeof question !== 'string' || !question.trim() || question.length > 500) return bad(res, 'question is required (max 500 chars)');
    try {
      const plant = await ownedPlant(req);
      const hist = Array.isArray(history) ? history.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string') : [];
      res.json(await chatAdvice({ question, plant, reading: plant ? await latest(plant.id) : null, history: hist }));
    } catch (e) { console.error(e); bad(res, 'Assistant is unavailable right now.', 502); }
  });

  app.use('/api', (_req, res) => bad(res, 'Not found', 404));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((_req, res) => bad(res, 'Not found', 404));

  // Catches errors from async handlers
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    if (!res.headersSent) bad(res, 'Server error', 500);
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await openDb();
  const cleanup = async () => {
    try {
      await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
      await db.prepare("DELETE FROM devices WHERE user_id IS NULL AND created_at < datetime('now','-7 days')").run();
    } catch (e) { console.error('cleanup failed', e); }
  };
  await cleanup(); setInterval(cleanup, 3600e3).unref();
  const port = process.env.PORT || 3001;
  createApp(db).listen(port, () => console.log(`Aurevia server running on http://localhost:${port}`));
}
