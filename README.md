# 🐔 ระบบ Smart Chicken Farm (3 โรงเลี้ยง) IoT System

ระบบมอนิเตอร์และควบคุมโรงเลี้ยงไก่ 3 โรงเรือนด้วย ESP32, SHT31, MQTT, SQLite และ Web Dashboard พร้อมระบบ **Automation Rule Engine** สำหรับรองรับโจทย์พิเศษในวันนำเสนอ

---

## 📁 โครงสร้างโปรเจกต์
- `server/server.js` : Backend Server (Node.js + Express + MQTT + SQLite + Socket.io)
- `public/` : Web Dashboard Realtime สไตล์ Dark Mode (Chart.js, การ์ด 3 โรงเรือน, สวิตช์ไฟ, ระบบตั้ง Rule)
- `simulator/simulate_nodes.js` : โปรแกรมจำลอง ESP32 ทั้ง 3 ตัว (สำหรับทดสอบระบบบนคอมพิวเตอร์ก่อนต่อวงจรจริง)
- `esp32_firmware/chicken_farm_node.ino` : โค้ดสำหรับแฟลชลงบอร์ด ESP32 จริง

---

## 🚀 วิธีการทดสอบระบบบนคอมพิวเตอร์ (ไม่ต้องรออุปกรณ์)

เปิด PowerShell หรือ Terminal 2 หน้าต่างในโฟลเดอร์นี้:

### หน้าต่างที่ 1: รัน Backend Server
```powershell
node server/server.js
```
เปิดเว็บเบราว์เซอร์ไปที่: **http://localhost:3001**

### หน้าต่างที่ 2: รัน Simulator จำลองข้อมูลทั้ง 3 โรง
```powershell
node simulator/simulate_nodes.js
```
จะเห็นข้อมูลอุณหภูมิและความชื้นของทั้ง 3 โรงเรือนวิ่งเข้าสู่ Dashboard แบบ Real-time ทันที สามารถกดเปิด-ปิดไฟบนหน้าเว็บ และสร้าง Rule เงื่อนไขทดสอบได้เลย!

---

## 🔌 การต่อวงจรฮาร์ดแวร์จริง (ESP32 + SHT31 + LED)
เมื่อได้อุปกรณ์มาแล้ว ต่อวงจรตามนี้สำหรับแต่ละบอร์ด:

### 1. เซนเซอร์ SHT31 (I2C)
| ขา SHT31 | ขาบนบอร์ด ESP32 | หน้าที่ |
| :--- | :--- | :--- |
| **VIN / VCC** | **3V3 (3.3V)** | จ่ายไฟเลี้ยง |
| **GND** | **GND** | กราวด์ |
| **SDA** | **GPIO 21** | ข้อมูล I2C Data |
| **SCL** | **GPIO 22** | สัญญาณ I2C Clock |

### 2. ไฟส่องสว่าง LED
- **แบบที่ 1 (ใช้บนบอร์ดเลย):** ไม่ต้องต่อสายใดๆ โค้ดจะใช้ Built-in LED ที่ขา **GPIO 2**
- **แบบที่ 2 (หลอด LED แยก):** 
  - ขาบวก (ขายาว) -> ตัวต้านทาน 220Ω -> ขา **GPIO 2**
  - ขาลบ (ขาสั้น) -> ขา **GND**

---

## 💻 การอัปโหลดโค้ดลงบอร์ด ESP32 (Arduino IDE)
1. ติดตั้ง Library ใน Arduino IDE:
   - `PubSubClient` (โดย Nick O'Leary)
   - `Adafruit SHT31 Library` (โดย Adafruit)
   - `ArduinoJson` (โดย Benoit Blanchon)
2. เปิดไฟล์ `esp32_firmware/chicken_farm_node.ino`
3. แก้ไขบรรทัด:
   ```cpp
   #define HOUSE_ID "house1"  // บอร์ด 1 ให้ใส่ "house1", บอร์ด 2 ใส่ "house2", บอร์ด 3 ใส่ "house3"
   const char* ssid = "ชื่อWiFiของคุณ";
   const char* password = "รหัสผ่านWiFi";
   ```
4. เสียบสาย USB แล้วกดปุ่ม **Upload**
