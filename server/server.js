const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://broker.hivemq.com:1883';
const MQTT_PREFIX = 'smartfarm_iot_2026'; // Prefix เพื่อไม่ให้ชนกับคนอื่นใน public broker

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ----------------------------------------------------
// 1. DATABASE SETUP (SQLite)
// ----------------------------------------------------
const dbPath = path.join(__dirname, 'farm_history.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite Database at:', dbPath);
});

db.serialize(() => {
  // บันทึกประวัติเซนเซอร์
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

  // ตาราง Automation Rules (สำหรับโจทย์พิเศษ)
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      house_id TEXT NOT NULL,
      metric TEXT NOT NULL,         -- 'temp' หรือ 'humidity' หรือ 'thi'
      operator TEXT NOT NULL,       -- '>', '<', '>='
      threshold REAL NOT NULL,
      action TEXT NOT NULL,         -- 'ON', 'OFF', 'BLINK'
      enabled INTEGER DEFAULT 1
    )
  `);
});

// Cache สถานะล่าสุดของ 3 โรงเลี้ยง
const housesState = {
  house1: { name: 'โรงเลี้ยงที่ 1', temp: 0, hum: 0, thi: 0, light: 'OFF', lastUpdate: null, online: false },
  house2: { name: 'โรงเลี้ยงที่ 2', temp: 0, hum: 0, thi: 0, light: 'OFF', lastUpdate: null, online: false },
  house3: { name: 'โรงเลี้ยงที่ 3', temp: 0, hum: 0, thi: 0, light: 'OFF', lastUpdate: null, online: false }
};

// ----------------------------------------------------
// 2. FORMULA: THI (ดัชนีความเครียดจากความร้อนของไก่)
// ----------------------------------------------------
function calculateTHI(temp, hum) {
  if (!temp || !hum) return 0;
  // THI = (1.8 * T + 32) - (0.55 - 0.0055 * RH) * ((1.8 * T + 32) - 58)
  const T = parseFloat(temp);
  const RH = parseFloat(hum);
  const thi = (1.8 * T + 32) - (0.55 - 0.0055 * RH) * ((1.8 * T + 32) - 58);
  return Math.round(thi * 10) / 10;
}

// ----------------------------------------------------
// 3. MQTT CLIENT SETUP
// ----------------------------------------------------
console.log(`Connecting to MQTT broker: ${MQTT_BROKER}...`);
const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: `backend_server_${Math.random().toString(16).substr(2, 8)}`,
  clean: true,
  reconnectPeriod: 2000
});

mqttClient.on('connect', () => {
  console.log('MQTT Connected successfully!');
  // Subscribe topics ของทั้ง 3 โรง
  mqttClient.subscribe(`${MQTT_PREFIX}/+/telemetry`);
  mqttClient.subscribe(`${MQTT_PREFIX}/+/light/status`);
  console.log(`Subscribed to: ${MQTT_PREFIX}/+/telemetry and light status`);
});

mqttClient.on('error', (err) => {
  console.error('MQTT Client Error:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('MQTT reconnecting...');
});

mqttClient.on('close', () => {
  console.log('MQTT connection closed');
});

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');
    const houseId = parts[1]; // เช่น house1, house2, house3
    const type = parts[2];    // telemetry หรือ light

    if (!housesState[houseId]) return;

    if (type === 'telemetry') {
      const temp = parseFloat(payload.temp || 0);
      const hum = parseFloat(payload.hum || 0);
      const thi = calculateTHI(temp, hum);
      const light = payload.light || housesState[houseId].light;

      housesState[houseId].temp = temp;
      housesState[houseId].hum = hum;
      housesState[houseId].thi = thi;
      housesState[houseId].light = light;
      housesState[houseId].lastUpdate = new Date().toISOString();
      housesState[houseId].online = true;

      // บันทึกลง SQLite
      const stmt = db.prepare(`
        INSERT INTO sensor_history (house_id, temperature, humidity, thi, light_state)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(houseId, temp, hum, thi, light);
      stmt.finalize();

      // Broadcast Realtime ไปยัง Web Dashboard ผ่าน Socket.io
      io.emit('telemetry', {
        houseId,
        data: housesState[houseId]
      });

      // ตรวจสอบเงื่อนไข Automation Rule (กันตายโจทย์พิเศษ!)
      evaluateAutomationRules(houseId, temp, hum, thi);

    } else if (type === 'light') {
      const state = payload.state;
      housesState[houseId].light = state;
      io.emit('light_status', { houseId, state });
    }
  } catch (err) {
    console.error('Error handling MQTT message:', err);
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

      if (triggered) {
        console.log(`[RULE TRIGGERED] ${rule.name}: ${rule.metric} ${rule.operator} ${rule.threshold} -> Action: ${rule.action}`);
        setLight(houseId, rule.action, `Automation: ${rule.name}`);
      }
    });
  });
}

// ฟังก์ชันสั่งการไฟส่องสว่างผ่าน MQTT
function setLight(houseId, action, sender = 'User') {
  if (!housesState[houseId]) return;
  const topic = `${MQTT_PREFIX}/${houseId}/light/set`;
  const payload = JSON.stringify({ state: action, sender });
  mqttClient.publish(topic, payload);
  housesState[houseId].light = action;
  io.emit('light_status', { houseId, state: action });
}

// ----------------------------------------------------
// 4. REST API ROUTES
// ----------------------------------------------------

// ดึงสถานะปัจจุบันของทุกโรงเลี้ยง
app.get('/api/houses', (req, res) => {
  res.json(housesState);
});

// ดึงประวัติข้อมูลสำหรับทำกราฟ
app.get('/api/history', (req, res) => {
  const houseId = req.query.house || 'house1';
  const limit = parseInt(req.query.limit) || 25;

  if (houseId === 'all') {
    db.all(
      `SELECT * FROM (
         SELECT * FROM sensor_history WHERE house_id = 'house1' ORDER BY id DESC LIMIT ?
       )
       UNION ALL
       SELECT * FROM (
         SELECT * FROM sensor_history WHERE house_id = 'house2' ORDER BY id DESC LIMIT ?
       )
       UNION ALL
       SELECT * FROM (
         SELECT * FROM sensor_history WHERE house_id = 'house3' ORDER BY id DESC LIMIT ?
       )
       ORDER BY id ASC`,
      [limit, limit, limit],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  } else {
    db.all(
      `SELECT * FROM sensor_history 
       WHERE house_id = ? 
       ORDER BY id DESC LIMIT ?`,
      [houseId, limit],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.reverse()); // เรียงตามเวลาเก่าไปใหม่ให้พล็อตกราฟสวย
      }
    );
  }
});

// ควบคุมการเปิด-ปิดไฟ
app.post('/api/light', (req, res) => {
  const { houseId, action } = req.body;
  if (!houseId || !action) return res.status(400).json({ error: 'Missing params' });

  if (houseId === 'all') {
    ['house1', 'house2', 'house3'].forEach(h => setLight(h, action));
  } else {
    setLight(houseId, action);
  }
  res.json({ success: true, houseId, action });
});

// CRUD Automation Rules (โจทย์พิเศษ)
app.get('/api/rules', (req, res) => {
  db.all('SELECT * FROM automation_rules', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/rules', (req, res) => {
  const { name, house_id, metric, operator, threshold, action } = req.body;
  db.run(
    `INSERT INTO automation_rules (name, house_id, metric, operator, threshold, action)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, house_id, metric, operator, threshold, action],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true });
    }
  );
});

app.delete('/api/rules/:id', (req, res) => {
  db.run('DELETE FROM automation_rules WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Export CSV
app.get('/api/export/csv', (req, res) => {
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

// ----------------------------------------------------
// 5. START SERVER
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
