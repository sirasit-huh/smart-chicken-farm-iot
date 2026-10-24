const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3001;
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtts://broker.hivemq.com:8883';
const MQTT_PREFIX = 'smartfarm_iot_2026';
const DEFAULT_SENSOR_KEY = 'iot_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ----------------------------------------------------
// 1. CRYPTO & AUTHENTICATION HELPERS
// ----------------------------------------------------
const activeSessions = new Map(); // token -> { id, username, role, createdAt }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  if (hashBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, expectedBuffer);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: Date.now()
  };
  activeSessions.set(token, sessionData);
  return token;
}

function getSessionFromHeader(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return activeSessions.get(token) || null;
}

function requireAuth(req, res, next) {
  const session = getSessionFromHeader(req);
  if (!session) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน (Unauthorized)' });
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSessionFromHeader(req);
  if (!session) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนใช้งาน (Unauthorized)' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'สิทธิ์เฉพาะผู้ดูแลระบบ (Admin Only)' });
  }
  req.user = session;
  next();
}

// ----------------------------------------------------
// 2. DATABASE SETUP (SQLite)
// ----------------------------------------------------
const dbPath = path.join(__dirname, 'farm_history.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite Database at:', dbPath);
});

// State caches
let farmsMap = {};   // farmId -> { id, name, location }
let housesState = {}; // coopId -> { id, farmId, farmName, name, sensorKey, temp, hum, thi, light, lastUpdate, lastRealUpdate, online }
let demoNodes = {};   // coopId -> { temp, hum, light }
let demoHistory = {}; // coopId -> []
const sensorRateLimit = {}; // coopId -> timestampMs

// Sensor Security Policy
let sensorSecurityConfig = {
  requireSensorKey: false, // หากเปิด บอร์ดต้องส่ง JSON field "key" ตรงกับ sensor_key ของโรงเรือน
  validateRange: true,     // ตรวจสอบค่า Temp (-10..70) และ Hum (0..100)
  rateLimitMs: 800         // ป้องกันการยิงสแปมถี่เกิน 0.8 วินาที
};

function logSecurityEvent(eventType, message) {
  db.run(
    `INSERT INTO security_logs (event_type, message) VALUES (?, ?)`,
    [eventType, message]
  );
  io.emit('security_log', {
    event_type: eventType,
    message,
    timestamp: new Date().toISOString()
  });
}

function loadTopologyFromDB(callback) {
  db.all(`SELECT * FROM farms ORDER BY created_at ASC`, [], (err, farms) => {
    if (err) return console.error('Error loading farms:', err);
    const nextFarms = {};
    (farms || []).forEach(f => {
      nextFarms[f.id] = { id: f.id, name: f.name, location: f.location || '' };
    });
    farmsMap = nextFarms;

    db.all(`SELECT * FROM coops ORDER BY created_at ASC`, [], (err2, coops) => {
      if (err2) return console.error('Error loading coops:', err2);
      const nextHouses = {};
      (coops || []).forEach((c, idx) => {
        const prev = housesState[c.id];
        const farmName = farmsMap[c.farm_id] ? farmsMap[c.farm_id].name : c.farm_id;
        nextHouses[c.id] = {
          id: c.id,
          farmId: c.farm_id,
          farmName,
          name: c.name,
          sensorKey: c.sensor_key || DEFAULT_SENSOR_KEY,
          temp: prev ? prev.temp : 0,
          hum: prev ? prev.hum : 0,
          thi: prev ? prev.thi : 0,
          light: prev ? prev.light : 'OFF',
          lastUpdate: prev ? prev.lastUpdate : null,
          lastRealUpdate: prev ? prev.lastRealUpdate : 0,
          online: prev ? prev.online : false
        };
        if (!demoNodes[c.id]) {
          demoNodes[c.id] = {
            temp: 28.0 + (idx % 4) * 1.1,
            hum: 64.0 + (idx % 4) * 2.5,
            light: 'OFF'
          };
        }
        if (!demoHistory[c.id]) {
          demoHistory[c.id] = [];
        }
      });

      // Clean up deleted coops from demo structures
      Object.keys(demoNodes).forEach(k => {
        if (!nextHouses[k]) {
          delete demoNodes[k];
          delete demoHistory[k];
        }
      });

      housesState = nextHouses;
      if (callback) callback();
    });
  });
}

db.serialize(() => {
  // 1. ตารางผู้ใช้งาน (Users)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. ตารางฟาร์ม (Farms)
  db.run(`
    CREATE TABLE IF NOT EXISTS farms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. ตารางโรงเรือน (Coops)
  db.run(`
    CREATE TABLE IF NOT EXISTS coops (
      id TEXT PRIMARY KEY,
      farm_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sensor_key TEXT NOT NULL DEFAULT 'iot_secret_2026',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. ตารางประวัติเซนเซอร์
  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      house_id TEXT NOT NULL,
      temperature REAL NOT NULL,
      humidity REAL NOT NULL,
      thi REAL,
      light_state TEXT DEFAULT 'OFF',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. ตาราง Automation Rules
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      house_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER DEFAULT 1
    )
  `);

  // 6. ตารางบันทึกความปลอดภัย (Security Audit Logs)
  db.run(`
    CREATE TABLE IF NOT EXISTS security_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed Default Users (admin / admin1234 และ user / user1234)
  db.get(`SELECT COUNT(*) as count FROM users`, [], (err, row) => {
    if (!err && row && row.count === 0) {
      const adminCred = hashPassword('admin1234');
      const userCred = hashPassword('user1234');
      db.run(
        `INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)`,
        ['admin', adminCred.hash, adminCred.salt, 'admin']
      );
      db.run(
        `INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)`,
        ['user', userCred.hash, userCred.salt, 'user']
      );
      console.log('🔐 Seeded default users: admin/admin1234 (Admin), user/user1234 (User)');
    }
  });

  // Seed Default Farm & 3 Coops
  db.get(`SELECT COUNT(*) as count FROM farms`, [], (err, row) => {
    if (!err && row && row.count === 0) {
      db.run(`INSERT INTO farms (id, name, location) VALUES ('farm1', 'ฟาร์มหลัก (Main Farm)', 'Zone A')`, () => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO coops (id, farm_id, name, sensor_key) VALUES (?, ?, ?, ?)`);
        stmt.run('house1', 'farm1', 'Chicken House #1', DEFAULT_SENSOR_KEY);
        stmt.run('house2', 'farm1', 'Chicken House #2', DEFAULT_SENSOR_KEY);
        stmt.run('house3', 'farm1', 'Chicken House #3', DEFAULT_SENSOR_KEY);
        stmt.finalize(() => {
          loadTopologyFromDB();
        });
      });
    } else {
      loadTopologyFromDB();
    }
  });
});

// ----------------------------------------------------
// 3. FORMULA: THI (ดัชนีความเครียดจากความร้อนของไก่)
// ----------------------------------------------------
function calculateTHI(temp, hum) {
  if (!temp || !hum) return 0;
  const T = parseFloat(temp);
  const RH = parseFloat(hum);
  const thi = (1.8 * T + 32) - (0.55 - 0.0055 * RH) * ((1.8 * T + 32) - 58);
  return Math.round(thi * 10) / 10;
}

// ----------------------------------------------------
// 4. MQTT CLIENT & SENSOR SECURITY
// ----------------------------------------------------
console.log(`Connecting to MQTT broker over TLS: ${MQTT_BROKER}...`);
const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: `backend_server_${Math.random().toString(16).substr(2, 8)}`,
  clean: true,
  reconnectPeriod: 2000,
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  console.log('MQTT Connected successfully!');
  mqttClient.subscribe(`${MQTT_PREFIX}/+/telemetry`);
  mqttClient.subscribe(`${MQTT_PREFIX}/+/light/status`);
  console.log(`Subscribed to: ${MQTT_PREFIX}/+/telemetry and light status`);
});

mqttClient.on('error', (err) => {
  console.error('MQTT Client Error:', err.message);
});

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');
    const houseId = parts[1];
    const type = parts[2];

    // [SENSOR SECURITY 1] ตรวจสอบว่าเป็น Coop ที่ลงทะเบียนในระบบหรือไม่
    if (!housesState[houseId]) {
      logSecurityEvent('SENSOR_BLOCKED', `บล็อกข้อมูลจากโรงเรือนที่ไม่ได้ลงทะเบียน: ${houseId}`);
      return;
    }

    const coop = housesState[houseId];

    if (type === 'telemetry') {
      const now = Date.now();

      // [SENSOR SECURITY 2] Rate Limiting ป้องกัน Flood / DoS
      if (sensorRateLimit[houseId] && (now - sensorRateLimit[houseId] < sensorSecurityConfig.rateLimitMs)) {
        return;
      }
      sensorRateLimit[houseId] = now;

      // [SENSOR SECURITY 3] ตรวจสอบ Sensor Key (หากเปิด Strict Mode หรือมีการส่ง key มาผิด)
      if (sensorSecurityConfig.requireSensorKey) {
        if (!payload.key || payload.key !== coop.sensorKey) {
          logSecurityEvent('SENSOR_BLOCKED', `[${houseId}] ปฏิเสธข้อมูลเนื่องจาก Sensor Key ไม่ถูกต้อง`);
          return;
        }
      } else if (payload.key !== undefined && payload.key !== coop.sensorKey) {
        logSecurityEvent('SENSOR_BLOCKED', `[${houseId}] ปฏิเสธข้อมูลเนื่องจาก Sensor Key ไม่ตรงกับระบบ`);
        return;
      }

      const temp = parseFloat(payload.temp);
      const hum = parseFloat(payload.hum);

      // [SENSOR SECURITY 4] ตรวจสอบความสมเหตุสมผลของข้อมูลเซนเซอร์ (Sanity / Anomaly Check)
      if (sensorSecurityConfig.validateRange) {
        if (isNaN(temp) || isNaN(hum) || temp < -10 || temp > 70 || hum < 0 || hum > 100) {
          logSecurityEvent('SENSOR_BLOCKED', `[${houseId}] ค่าเซนเซอร์ผิดปกติ (Temp: ${payload.temp}, Hum: ${payload.hum})`);
          return;
        }
      }

      const thi = calculateTHI(temp, hum);
      const light = payload.light || coop.light;

      coop.temp = temp;
      coop.hum = hum;
      coop.thi = thi;
      coop.light = light;
      coop.lastUpdate = new Date().toISOString();
      coop.lastRealUpdate = now;
      coop.online = true;

      const stmt = db.prepare(`
        INSERT INTO sensor_history (house_id, temperature, humidity, thi, light_state)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(houseId, temp, hum, thi, light);
      stmt.finalize();

      io.emit('telemetry', {
        houseId,
        data: coop
      });

      evaluateAutomationRules(houseId, temp, hum, thi);

    } else if (type === 'light') {
      if (!coop.online) return;
      const state = payload.state;
      coop.light = state;
      io.emit('light_status', { houseId, state });
    }
  } catch (err) {
    logSecurityEvent('SENSOR_BLOCKED', `ได้รับ MQTT Payload ที่ไม่ใช่ JSON ที่ถูกต้อง`);
  }
});

// ตรวจสอบ Automation Rules
function evaluateAutomationRules(houseId, temp, hum, thi) {
  db.all('SELECT * FROM automation_rules WHERE enabled = 1 AND (house_id = ? OR house_id = "all")', [houseId], (err, rules) => {
    if (err || !rules) return;

    rules.forEach(rule => {
      let val = (rule.metric === 'temp') ? temp : (rule.metric === 'hum') ? hum : thi;
      let triggered = false;

      if (rule.operator === '>' && val > rule.threshold) triggered = true;
      if (rule.operator === '<' && val < rule.threshold) triggered = true;
      if (rule.operator === '>=' && val >= rule.threshold) triggered = true;
      if (rule.operator === '<=' && val <= rule.threshold) triggered = true;
      if (rule.operator === '==' && val === rule.threshold) triggered = true;

      if (triggered && housesState[houseId] && housesState[houseId].light !== rule.action) {
        setLight(houseId, rule.action, `Automation: ${rule.name}`);
      }
    });
  });
}

// ฟังก์ชันสั่งการไฟส่องสว่างผ่าน MQTT (สั่งได้เฉพาะโรงเรือนที่ Online เท่านั้น)
function setLight(houseId, action, sender = 'User') {
  if (!housesState[houseId] || !housesState[houseId].online) return false;
  const topic = `${MQTT_PREFIX}/${houseId}/light/set`;
  const payload = JSON.stringify({ state: action, sender });
  mqttClient.publish(topic, payload);
  housesState[houseId].light = action;
  if (demoMode && demoNodes[houseId]) {
    demoNodes[houseId].light = action;
  }
  io.emit('light_status', { houseId, state: action });
  return true;
}

// ----------------------------------------------------
// 5. HEARTBEAT TIMEOUT & DEMO MODE
// ----------------------------------------------------
const TIMEOUT_OFFLINE_MS = 10000;

setInterval(() => {
  if (demoMode) return;
  const now = Date.now();

  Object.keys(housesState).forEach(houseId => {
    const house = housesState[houseId];
    if (house.online) {
      const last = house.lastRealUpdate || 0;
      if (now - last > TIMEOUT_OFFLINE_MS) {
        house.online = false;
        house.temp = 0;
        house.hum = 0;
        house.thi = 0;
        house.light = 'OFF';
        house.lastUpdate = null;
        io.emit('telemetry', {
          houseId,
          data: house
        });
      }
    }
  });
}, 3000);

let demoMode = false;
let demoInterval = null;

function generateDemoStep() {
  const nowIso = new Date().toISOString();
  Object.keys(housesState).forEach((houseId, idx) => {
    if (!demoNodes[houseId]) {
      demoNodes[houseId] = { temp: 28.5 + (idx % 3), hum: 66.0 + (idx % 3) * 2, light: 'OFF' };
    }
    if (!demoHistory[houseId]) {
      demoHistory[houseId] = [];
    }
    const node = demoNodes[houseId];
    node.temp += (Math.random() - 0.5) * 0.6;
    node.hum += (Math.random() - 0.5) * 1.0;

    if (node.temp < 25) node.temp = 25.5;
    if (node.temp > 38) node.temp = 37.5;
    if (node.hum < 50) node.hum = 52.0;
    if (node.hum > 85) node.hum = 83.0;

    const temp = parseFloat(node.temp.toFixed(1));
    const hum = parseFloat(node.hum.toFixed(1));
    const thi = calculateTHI(temp, hum);
    const light = housesState[houseId].light || 'OFF';

    housesState[houseId].temp = temp;
    housesState[houseId].hum = hum;
    housesState[houseId].thi = thi;
    housesState[houseId].light = light;
    housesState[houseId].lastUpdate = nowIso;
    housesState[houseId].online = true;

    demoHistory[houseId].push({
      house_id: houseId,
      temperature: temp,
      humidity: hum,
      thi,
      light_state: light,
      timestamp: nowIso
    });
    if (demoHistory[houseId].length > 25) {
      demoHistory[houseId].shift();
    }

    io.emit('telemetry', {
      houseId,
      data: housesState[houseId]
    });

    evaluateAutomationRules(houseId, temp, hum, thi);
  });
}

function startDemoMode() {
  if (demoInterval) clearInterval(demoInterval);
  demoMode = true;
  Object.keys(housesState).forEach(k => { demoHistory[k] = []; });
  generateDemoStep();
  demoInterval = setInterval(generateDemoStep, 3000);
}

function stopDemoMode() {
  demoMode = false;
  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
  }
  Object.keys(housesState).forEach(k => { demoHistory[k] = []; });

  const now = Date.now();
  Object.keys(housesState).forEach(houseId => {
    const lastReal = housesState[houseId].lastRealUpdate || 0;
    if (!lastReal || (now - lastReal > TIMEOUT_OFFLINE_MS)) {
      housesState[houseId].online = false;
      housesState[houseId].temp = 0;
      housesState[houseId].hum = 0;
      housesState[houseId].thi = 0;
      housesState[houseId].light = 'OFF';
      housesState[houseId].lastUpdate = null;
    }
    io.emit('telemetry', {
      houseId,
      data: housesState[houseId]
    });
  });
}

io.on('connection', (socket) => {
  socket.emit('demo_status', { demoMode });
});

// ----------------------------------------------------
// 6. AUTHENTICATION & USER MANAGEMENT ROUTES
// ----------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [username.trim()], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
      logSecurityEvent('AUTH', `พยายามเข้าสู่ระบบล้มเหลวสำหรับผู้ใช้: ${username}`);
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const token = createSession(user);
    logSecurityEvent('AUTH', `ผู้ใช้ ${user.username} (${user.role}) เข้าสู่ระบบสำเร็จ`);
    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.slice(7).trim();
  activeSessions.delete(token);
  logSecurityEvent('AUTH', `ผู้ใช้ ${req.user.username} ออกจากระบบ`);
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Admin: จัดการผู้ใช้งาน
app.get('/api/users', requireAdmin, (req, res) => {
  db.all(`SELECT id, username, role, created_at FROM users ORDER BY id ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณาระบุ username และ password' });
  }
  const cleanUser = username.trim();
  const validRole = role === 'admin' ? 'admin' : 'user';
  const { salt, hash } = hashPassword(password);

  db.run(
    `INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)`,
    [cleanUser, hash, salt, validRole],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'มีชื่อผู้ใช้นี้ในระบบแล้ว' });
        }
        return res.status(500).json({ error: err.message });
      }
      logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} สร้างบัญชีผู้ใช้ใหม่: ${cleanUser} (${validRole})`);
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'ไม่สามารถลบบัญชีที่กำลังใช้งานอยู่ได้' });
  }
  db.run(`DELETE FROM users WHERE id = ?`, [targetId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} ลบบัญชีผู้ใช้ ID: ${targetId}`);
    res.json({ success: true });
  });
});

// ----------------------------------------------------
// 7. FARMS & COOPS ROUTES (Admin เท่านั้นที่เพิ่ม/ลบได้)
// ----------------------------------------------------
app.get('/api/topology', requireAuth, (req, res) => {
  res.json({
    farms: Object.values(farmsMap),
    houses: housesState
  });
});

app.post('/api/farms', requireAdmin, (req, res) => {
  const { id, name, location } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อฟาร์ม' });
  }
  let cleanId = (id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) {
    let idx = Object.keys(farmsMap).length + 1;
    while (farmsMap[`farm${idx}`]) idx++;
    cleanId = `farm${idx}`;
  }

  db.run(
    `INSERT INTO farms (id, name, location) VALUES (?, ?, ?)`,
    [cleanId, name.trim(), (location || '').trim()],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'รหัสฟาร์มนี้มีอยู่แล้ว' });
        return res.status(500).json({ error: err.message });
      }
      logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} เพิ่มฟาร์มใหม่: ${name} (${cleanId})`);
      loadTopologyFromDB(() => {
        io.emit('topology_updated', { farms: Object.values(farmsMap), houses: housesState });
        res.json({ success: true, id: cleanId });
      });
    }
  );
});

app.delete('/api/farms/:id', requireAdmin, (req, res) => {
  const farmId = req.params.id;
  if (Object.keys(farmsMap).length <= 1) {
    return res.status(400).json({ error: 'ต้องมีฟาร์มอย่างน้อย 1 ฟาร์มในระบบ' });
  }
  db.serialize(() => {
    db.run(`DELETE FROM coops WHERE farm_id = ?`, [farmId]);
    db.run(`DELETE FROM farms WHERE id = ?`, [farmId], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} ลบฟาร์ม: ${farmId}`);
      loadTopologyFromDB(() => {
        io.emit('topology_updated', { farms: Object.values(farmsMap), houses: housesState });
        res.json({ success: true });
      });
    });
  });
});

app.post('/api/coops', requireAdmin, (req, res) => {
  const { id, farm_id, name, sensor_key } = req.body || {};
  if (!farm_id || !name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุฟาร์มและชื่อโรงเรือน' });
  }
  let cleanId = (id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) {
    let idx = Object.keys(housesState).length + 1;
    while (housesState[`house${idx}`]) idx++;
    cleanId = `house${idx}`;
  }
  if (!farmsMap[farm_id]) {
    return res.status(400).json({ error: 'ไม่พบฟาร์มที่เลือก' });
  }
  const keyToUse = (sensor_key || DEFAULT_SENSOR_KEY).trim();

  db.run(
    `INSERT INTO coops (id, farm_id, name, sensor_key) VALUES (?, ?, ?, ?)`,
    [cleanId, farm_id, name.trim(), keyToUse],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'รหัสโรงเรือนนี้มีอยู่แล้ว' });
        return res.status(500).json({ error: err.message });
      }
      logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} เพิ่มโรงเรือนใหม่: ${name} (${cleanId}) ในฟาร์ม ${farm_id}`);
      loadTopologyFromDB(() => {
        if (demoMode) generateDemoStep();
        io.emit('topology_updated', { farms: Object.values(farmsMap), houses: housesState });
        res.json({ success: true, id: cleanId });
      });
    }
  );
});

app.delete('/api/coops/:id', requireAdmin, (req, res) => {
  const coopId = req.params.id;
  db.run(`DELETE FROM coops WHERE id = ?`, [coopId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} ลบโรงเรือน: ${coopId}`);
    loadTopologyFromDB(() => {
      io.emit('topology_updated', { farms: Object.values(farmsMap), houses: housesState });
      res.json({ success: true });
    });
  });
});

// ----------------------------------------------------
// 8. SENSOR SECURITY SETTINGS & LOGS (Admin Only)
// ----------------------------------------------------
app.get('/api/security/status', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM security_logs ORDER BY id DESC LIMIT 40`, [], (err, logs) => {
    res.json({
      config: sensorSecurityConfig,
      logs: logs || []
    });
  });
});

app.post('/api/security/config', requireAdmin, (req, res) => {
  const { requireSensorKey, validateRange } = req.body || {};
  if (typeof requireSensorKey === 'boolean') {
    sensorSecurityConfig.requireSensorKey = requireSensorKey;
  }
  if (typeof validateRange === 'boolean') {
    sensorSecurityConfig.validateRange = validateRange;
  }
  logSecurityEvent('ADMIN_ACTION', `Admin ${req.user.username} อัปเดตตั้งค่า Sensor Security (StrictKey=${sensorSecurityConfig.requireSensorKey})`);
  res.json({ success: true, config: sensorSecurityConfig });
});

// ----------------------------------------------------
// 9. TELEMETRY, LIGHT, RULES & EXPORT ROUTES (Protected)
// ----------------------------------------------------
app.get('/api/houses', requireAuth, (req, res) => {
  res.json(housesState);
});

function buildZeroRows(houseId, count = 10) {
  const rows = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    rows.push({
      house_id: houseId,
      temperature: 0,
      humidity: 0,
      thi: 0,
      light_state: 'OFF',
      timestamp: new Date(now - i * 3000).toISOString()
    });
  }
  return rows;
}

app.get('/api/history', requireAuth, (req, res) => {
  const houseId = req.query.house || 'all';
  const farmId = req.query.farm || 'all';
  const limit = parseInt(req.query.limit, 10) || 25;

  const targetCoopIds = Object.keys(housesState).filter(id => {
    if (farmId !== 'all' && housesState[id].farmId !== farmId) return false;
    if (houseId !== 'all' && id !== houseId) return false;
    return true;
  });

  if (demoMode) {
    let combined = [];
    targetCoopIds.forEach(id => {
      combined = combined.concat((demoHistory[id] || []).slice(-limit));
    });
    return res.json(combined);
  }

  const promises = targetCoopIds.map(h => new Promise((resolve) => {
    if (!housesState[h] || !housesState[h].online) {
      return resolve(buildZeroRows(h, 10));
    }
    db.all(
      `SELECT * FROM sensor_history WHERE house_id = ? ORDER BY id DESC LIMIT ?`,
      [h, limit],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return resolve(buildZeroRows(h, 10));
        resolve(rows.reverse());
      }
    );
  }));

  Promise.all(promises).then(results => {
    const merged = [].concat(...results);
    res.json(merged);
  });
});

app.post('/api/light', requireAuth, (req, res) => {
  const { houseId, farmId, action } = req.body || {};
  if (!houseId || !action) return res.status(400).json({ error: 'Missing params' });

  if (houseId === 'all') {
    Object.keys(housesState).forEach(h => {
      if (!farmId || farmId === 'all' || housesState[h].farmId === farmId) {
        setLight(h, action, req.user.username);
      }
    });
  } else {
    setLight(houseId, action, req.user.username);
  }
  res.json({ success: true, houseId, action });
});

app.get('/api/rules', requireAuth, (req, res) => {
  db.all('SELECT * FROM automation_rules', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/rules', requireAuth, (req, res) => {
  const { name, house_id, metric, operator, threshold, action } = req.body || {};
  db.run(
    `INSERT INTO automation_rules (name, house_id, metric, operator, threshold, action)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, house_id, metric, operator, threshold, action],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.delete('/api/rules/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM automation_rules WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/export/csv', requireAuth, (req, res) => {
  db.all('SELECT * FROM sensor_history ORDER BY id DESC LIMIT 500', [], (err, rows) => {
    if (err) return res.status(500).send('Error');
    let csv = 'ID,House,Temperature,Humidity,THI,Light,Timestamp\n';
    rows.forEach(r => {
      csv += `${r.id},${r.house_id},${r.temperature},${r.humidity},${r.thi},${r.light_state},${r.timestamp}\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('chicken_farm_data.csv');
    res.send(csv);
  });
});

app.get('/api/demo', requireAuth, (req, res) => {
  res.json({ demoMode });
});

app.post('/api/demo', requireAuth, (req, res) => {
  const enabled = req.body && req.body.enabled !== undefined ? !!req.body.enabled : !demoMode;
  if (enabled) {
    startDemoMode();
  } else {
    stopDemoMode();
  }
  io.emit('demo_status', { demoMode });
  res.json({ success: true, demoMode });
});

// ----------------------------------------------------
// 10. START SERVER
// ----------------------------------------------------
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🐔 Smart Chicken Farm System Server Running!`);
  console.log(`🌐 Dashboard URL: http://localhost:${PORT}`);
  console.log(`📡 MQTT Broker   : ${MQTT_BROKER}`);
  console.log(`🔑 MQTT Topic Base: ${MQTT_PREFIX}`);
  console.log(`=======================================================`);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
