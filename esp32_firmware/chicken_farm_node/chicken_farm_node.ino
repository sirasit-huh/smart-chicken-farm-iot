/*
  ==============================================================
  Project: Smart Chicken Farm - ESP32 Node Firmware
  Sensor : SHT31 (I2C: SDA=21, SCL=22)
  Output : LED (Pin 2 หรือขานอกที่ต้องการ)
  Protocol: MQTT
  ==============================================================

  วิธีนำไปใช้กับ 3 บอร์ด:
  1. บอร์ดที่ 1: ตั้ง HOUSE_ID เป็น "house1"
  2. บอร์ดที่ 2: ตั้ง HOUSE_ID เป็น "house2"
  3. บอร์ดที่ 3: ตั้ง HOUSE_ID เป็น "house3"
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <ArduinoJson.h>

// ----------------------------------------------------
// 1. ตั้งค่าบอร์ดและเครือข่าย
// ----------------------------------------------------
#define HOUSE_ID        "house3"          // เปลี่ยนเป็น house1, house2, house3 สำหรับแต่ละบอร์ด
#define LED_PIN         2                 // ขา LED บนบอร์ด ESP32 (GPIO 2) หรือเปลี่ยนเป็นขาอื่นที่ต่อ LED แยก

const char* ssid        = "sirasit";     // ชื่อ WiFi (หรือแชร์ Hotspot จากมือถือ)
const char* password    = "0988315400"; // รหัสผ่าน WiFi

const char* mqtt_server = "broker.hivemq.com"; // MQTT Public Broker (เสถียรกับเน็ต Hotspot มือถือ)
const int   mqtt_port   = 1883;
const char* mqtt_prefix = "smartfarm_iot_2026"; // Prefix ตรงกับ Backend Server

// MQTT Topics
String topicTelemetry   = String(mqtt_prefix) + "/" + HOUSE_ID + "/telemetry";
String topicLightSet    = String(mqtt_prefix) + "/" + HOUSE_ID + "/light/set";
String topicLightStatus = String(mqtt_prefix) + "/" + HOUSE_ID + "/light/status";

// ออบเจ็กต์การทำงาน
WiFiClient espClient;
PubSubClient client(espClient);
Adafruit_SHT31 sht31 = Adafruit_SHT31();

unsigned long lastMsg = 0;
String currentLightState = "OFF";

// ----------------------------------------------------
// 2. ฟังก์ชันจัดการคำสั่งจาก MQTT (Callback)
// ----------------------------------------------------
void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.print("คำสั่งได้รับจาก Topic [");
  Serial.print(topic);
  Serial.print("]: ");
  Serial.println(message);

  // Parse JSON คำสั่งเปิด/ปิดไฟ
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, message);

  if (!error) {
    const char* state = doc["state"];
    if (state) {
      if (String(state) == "ON") {
        digitalWrite(LED_PIN, HIGH);
        currentLightState = "ON";
      } else if (String(state) == "OFF") {
        digitalWrite(LED_PIN, LOW);
        currentLightState = "OFF";
      }

      // ส่งสถานะปัจจุบันกลับไปยืนยัน
      StaticJsonDocument<100> resDoc;
      resDoc["state"] = currentLightState;
      char resBuffer[100];
      serializeJson(resDoc, resBuffer);
      client.publish(topicLightStatus.c_str(), resBuffer);
      Serial.printf(" ไฟโรงเลี้ยง %s -> %s\n", HOUSE_ID, currentLightState.c_str());
    }
  }
}

// ----------------------------------------------------
// 3. ฟังก์ชันเชื่อมต่อ WiFi และ MQTT
// ----------------------------------------------------
void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("กำลังเชื่อมต่อ WiFi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\n WiFi เชื่อมต่อสำเร็จ!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("กำลังเชื่อมต่อ MQTT...");
    String clientId = "ESP32_" + String(HOUSE_ID) + "_" + String(random(0xffff), HEX);

    if (client.connect(clientId.c_str())) {
      Serial.println(" สำเร็จ!");
      // Subscribe รับคำสั่งเปิด-ปิดไฟ
      client.subscribe(topicLightSet.c_str());
      Serial.printf("📡 รอรับคำสั่งที่ Topic: %s\n", topicLightSet.c_str());
    } else {
      Serial.print(" ล้มเหลว, rc=");
      Serial.print(client.state());
      Serial.println(" ลองใหม่ใน 5 วินาที");
      delay(5000);
    }
  }
}

// ----------------------------------------------------
// 4. Setup & Main Loop
// ----------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW); // เริ่มต้นปิดไฟ

  setup_wifi();

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);

  // เริ่มต้นเซนเซอร์ SHT31 (I2C)
  if (!sht31.begin(0x44)) {
    Serial.println(" ไม่พบเซนเซอร์ SHT31! ตรวจสอบสายต่อ SDA/SCL");
  } else {
    Serial.println(" เซนเซอร์ SHT31 พร้อมทำงาน!");
  }
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  // ส่งข้อมูลทุกๆ 3 วินาที
  unsigned long now = millis();
  if (now - lastMsg > 3000) {
    lastMsg = now;

    float t = sht31.readTemperature();
    float h = sht31.readHumidity();

    // กรณีอ่านค่าไม่ได้ หรือยังไม่ได้เสียบเซนเซอร์จริง (จำลองค่าชั่วคราวเพื่อเทส)
    if (isnan(t) || isnan(h)) {
      Serial.println(" อ่านค่า SHT31 ไม่ได้ (ใช้ค่าจำลองแทน)");
      t = 30.5;
      h = 65.0;
    }

    // สร้าง JSON Data
    StaticJsonDocument<200> doc;
    doc["temp"] = round(t * 10) / 10.0;
    doc["hum"]  = round(h * 10) / 10.0;
    doc["light"] = currentLightState;

    char buffer[256];
    serializeJson(doc, buffer);

    // ยิงขึ้น MQTT
    client.publish(topicTelemetry.c_str(), buffer);
    Serial.printf(" [%s] Temp: %.1f °C, Hum: %.1f %% -> Sent!\n", HOUSE_ID, t, h);
  }
}
