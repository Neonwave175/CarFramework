/*
 * AVIF Lab robot-camera WebSocket starter
 * Board profile: AI Thinker ESP32-CAM
 * Libraries: ESP32 board package, WebSockets (Links2004), ArduinoJson
 *
 * This streams JPEG frames to AVIF Lab over the local Wi-Fi network and receives
 * short, authenticated movement commands. Motor functions are intentionally stubs:
 * wire them to your actual motor driver and test with the wheels lifted first.
 */
#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "CHANGE_ME_WIFI";
const char* WIFI_PASSWORD = "CHANGE_ME_WIFI_PASSWORD";
const char* API_HOST = "192.168.1.100";   // PC running AVIF Lab, LAN IP only
const uint16_t API_PORT = 8000;
const char* DEVICE_TOKEN = "PASTE_THE_ROBOT_DEVICE_TOKEN_HERE";

WebSocketsClient webSocket;
bool deviceAuthenticated = false;
unsigned long lastFrameMs = 0;
unsigned long commandDeadlineMs = 0;
bool commandActive = false;

// AI Thinker ESP32-CAM pin mapping.
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

void stopMotors() {
  // TODO: Set both motor-driver channels to zero PWM here.
  // This must be a hardware-side fail-safe, not just a browser button.
  commandActive = false;
  Serial.println("MOTOR STOP (stub; connect your motor driver here)");
}

void applyMotorCommand(const char* command, float speed) {
  // TODO: Map forward/reverse/left/right to your H-bridge pins and PWM.
  // Keep speed limited. Do not use ESP32-CAM pins that are assigned to the camera.
  Serial.printf("MOTOR CMD (stub): %s at %.2f\n", command, speed);
}

void handleCommand(JsonDocument& doc) {
  const char* kind = doc["type"] | "";
  if (strcmp(kind, "command") != 0) return;
  const char* command = doc["command"] | "stop";
  float speed = doc["speed"] | 0.0f;
  unsigned long durationMs = doc["duration_ms"] | 0UL;
  if (strcmp(command, "stop") == 0) {
    stopMotors();
    return;
  }
  const bool allowed = strcmp(command, "forward") == 0 || strcmp(command, "reverse") == 0 ||
                       strcmp(command, "left") == 0 || strcmp(command, "right") == 0;
  if (!allowed) return;
  if (speed < 0.0f) speed = 0.0f;
  if (speed > 0.25f) speed = 0.25f;
  if (durationMs == 0 || durationMs > 500) durationMs = 300;
  applyMotorCommand(command, speed);
  commandDeadlineMs = millis() + durationMs;
  commandActive = true;
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      deviceAuthenticated = false;
      StaticJsonDocument<160> doc;
      doc["type"] = "auth";
      doc["token"] = DEVICE_TOKEN;
      String auth;
      serializeJson(doc, auth);
      webSocket.sendTXT(auth);
      Serial.println("WebSocket connected; sent device auth.");
      break;
    }
    case WStype_TEXT: {
      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, payload, length);
      if (error) return;
      const char* typeName = doc["type"] | "";
      if (strcmp(typeName, "auth") == 0 && doc["ok"] == true) {
        deviceAuthenticated = true;
        Serial.println("AVIF Lab API authenticated this robot.");
      } else if (strcmp(typeName, "error") == 0) {
        Serial.printf("API error: %s\n", doc["message"] | "unknown");
        deviceAuthenticated = false;
      } else if (deviceAuthenticated) {
        handleCommand(doc);
      }
      break;
    }
    case WStype_DISCONNECTED:
      deviceAuthenticated = false;
      stopMotors();
      Serial.println("WebSocket disconnected.");
      break;
    default:
      break;
  }
}

bool startCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;  // 640x480: start small for Wi-Fi bandwidth
  config.jpeg_quality = 14;           // lower number = higher quality / larger frames
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  return esp_camera_init(&config) == ESP_OK;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  if (!startCamera()) {
    Serial.println("Camera init failed. Check board profile and camera pin map.");
    while (true) delay(1000);
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print('.');
  }
  Serial.printf("\nWi-Fi connected. Robot IP: %s\n", WiFi.localIP().toString().c_str());
  webSocket.begin(API_HOST, API_PORT, "/ws/robot/camera");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);
  webSocket.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  webSocket.loop();
  if (commandActive && static_cast<long>(millis() - commandDeadlineMs) >= 0) {
    stopMotors();  // hardware-side watchdog for every directional pulse
  }
  if (deviceAuthenticated && millis() - lastFrameMs >= 90) { // ~11 fps upper bound
    lastFrameMs = millis();
    camera_fb_t* frame = esp_camera_fb_get();
    if (frame) {
      if (frame->format == PIXFORMAT_JPEG && frame->len <= 1500000) {
        webSocket.sendBIN(frame->buf, frame->len);
      }
      esp_camera_fb_return(frame);
    }
  }
  // TODO: send a {"type":"telemetry","data":{"sensor_left":...,"sensor_right":...,"battery":...}}
  // message via webSocket.sendTXT() after wiring your real line sensors and battery monitor.
  delay(1);
}
