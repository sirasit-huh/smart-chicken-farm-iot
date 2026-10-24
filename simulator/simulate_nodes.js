/**
 * สคริปต์จำลองการทำงานของบอร์ด ESP32 ทั้ง 3 โรงเรือน
 * รันด้วยคำสั่ง: node simulator/simulate_nodes.js
 */
const mqtt = require('mqtt');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtts://broker.hivemq.com:8883';
const MQTT_PREFIX = 'smartfarm_iot_2026';

const client = mqtt.connect(MQTT_BROKER, {
  clientId: `simulator_${Math.random().toString(16).substr(2, 8)}`,
  rejectUnauthorized: false
});

// สถานะจำลองของ 3 โรงเรือน
const nodes = {
  house1: { temp: 28.5, hum: 65.0, light: 'OFF' },
  house2: { temp: 29.2, hum: 68.4, light: 'OFF' },
  house3: { temp: 31.0, hum: 72.1, light: 'OFF' }
};

client.on('connect', () => {
  console.log('✅ Simulator connected to MQTT Broker:', MQTT_BROKER);
  console.log('🐔 Simulating 3 Chicken Houses (ESP32 Nodes)...');

  // Subscribe เพื่อรอรับคำสั่งเปิด-ปิดไฟจาก Dashboard
  ['house1', 'house2', 'house3'].forEach(id => {
    const topic = `${MQTT_PREFIX}/${id}/light/set`;
    client.subscribe(topic);
    console.log(`📡 Node ${id} listening on: ${topic}`);
  });

  // ส่งข้อมูลเซนเซอร์จำลองขึ้นทุกๆ 3 วินาที
  setInterval(publishTelemetry, 3000);
});

// รับคำสั่งเปิด/ปิดไฟ
client.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    const houseId = topic.split('/')[1];

    if (nodes[houseId]) {
      nodes[houseId].light = payload.state;
      console.log(`💡 [${houseId.toUpperCase()}] Light changed to -> ${payload.state}`);

      // ส่งสถานะยืนยันกลับไปยัง Server
      client.publish(
        `${MQTT_PREFIX}/${houseId}/light/status`,
        JSON.stringify({ state: payload.state })
      );
    }
  } catch (e) {
    console.error('Error parsing command:', e);
  }
});

// จำลองการสุ่มขยับค่าอุณหภูมิและความชื้นแบบธรรมชาติ
function publishTelemetry() {
  Object.keys(nodes).forEach(houseId => {
    const node = nodes[houseId];

    // สุ่มขยับ ±0.3 องศา และ ±0.5% ความชื้น
    node.temp += (Math.random() - 0.5) * 0.6;
    node.hum += (Math.random() - 0.5) * 1.0;

    // คุมให้อยู่ในช่วงสมจริง
    if (node.temp < 25) node.temp = 25.5;
    if (node.temp > 38) node.temp = 37.5;
    if (node.hum < 50) node.hum = 52.0;
    if (node.hum > 85) node.hum = 83.0;

    const data = {
      temp: parseFloat(node.temp.toFixed(1)),
      hum: parseFloat(node.hum.toFixed(1)),
      light: node.light,
      key: 'iot_secret_2026'
    };

    const topic = `${MQTT_PREFIX}/${houseId}/telemetry`;
    client.publish(topic, JSON.stringify(data));
  });

  console.log(`[Telemetry Sent] H1: ${nodes.house1.temp.toFixed(1)}°C | H2: ${nodes.house2.temp.toFixed(1)}°C | H3: ${nodes.house3.temp.toFixed(1)}°C`);
}
