// sniffmaster_ble_presence.cpp — BLE passive scan + occupancy estimation
//
// Performs short passive BLE scans to count nearby devices and derive an
// occupancy index (0–100).  Runs cooperatively: blePresenceTick() is called
// from the main loop and returns quickly; the NimBLE scan callback runs on
// the BLE task.
//
// Occupancy index formula:
//   raw_score = clamp(deviceCount, 0, BLE_OCC_SAT_COUNT) / BLE_OCC_SAT_COUNT
//   occupancyIndex = round(raw_score * 100)
//
// Each device entry is keyed by the lower 4 bytes of its MAC address to
// reduce the risk of inadvertently logging stable hardware MAC addresses
// while still distinguishing devices within a short time window.

#include "sniffmaster_ble_presence.h"
#include <Arduino.h>

// ── NimBLE availability guard ─────────────────────────────────────────────
// NimBLE-Arduino must be present in lib_deps for the scan to work.
// If the header is missing (e.g. unit-test build), fall back to the stub.
#if __has_include(<NimBLEDevice.h>)
#  define BLE_SCAN_ENABLED 1
#  include <NimBLEDevice.h>
#else
#  define BLE_SCAN_ENABLED 0
#endif

// ── Safe empty string ─────────────────────────────────────────────────────
static const char EMPTY_STR[] = "";

// ── Device ring buffer ────────────────────────────────────────────────────
struct BleDeviceEntry {
    uint32_t addrHash;      // lower 4 bytes of MAC (privacy-friendly key)
    int8_t   rssi;
    uint32_t lastSeenMs;
};

static BleDeviceEntry deviceBuf[BLE_MAX_DEVICES];
static int            deviceBufCount = 0;

// ── Module state ──────────────────────────────────────────────────────────
static bool           bleInitOk         = false;
static bool           scanPaused        = false;
static unsigned long  pauseUntilMs      = 0;
static unsigned long  lastScanStartMs   = 0;
static int            bleScanState      = 0;  // 0=idle 1=scanning 2=results ready

// ── Public snapshot (updated after each scan) ─────────────────────────────
BlePresenceSnapshot ble = {
    .state           = 0,
    .confidence      = 0.0f,
    .lastRssi        = -100,
    .emaRssi         = -100.0f,
    .matchedName     = EMPTY_STR,
    .seenRecently    = false,
    .enabled         = false,
    .rssiStdDev      = 0.0f,
    .matchedAddress  = EMPTY_STR,
    .targetConfigured= false,
    .deviceCount     = 0,
    .occupancyIndex  = 0,
    .avgRssi         = -100.0f,
};

// ── Interval between scan bursts ──────────────────────────────────────────
static const unsigned long SCAN_INTERVAL_MS = 20000UL;  // scan every 20 s

// ── Helper: evict expired entries from the device buffer ─────────────────
static void evictExpired(uint32_t nowMs) {
    int write = 0;
    for (int i = 0; i < deviceBufCount; i++) {
        if (nowMs - deviceBuf[i].lastSeenMs < BLE_DEVICE_TTL_MS) {
            deviceBuf[write++] = deviceBuf[i];
        }
    }
    deviceBufCount = write;
}

// ── Helper: upsert a device entry ─────────────────────────────────────────
static void upsertDevice(uint32_t addrHash, int8_t rssi, uint32_t nowMs) {
    for (int i = 0; i < deviceBufCount; i++) {
        if (deviceBuf[i].addrHash == addrHash) {
            deviceBuf[i].rssi       = rssi;
            deviceBuf[i].lastSeenMs = nowMs;
            return;
        }
    }
    if (deviceBufCount < BLE_MAX_DEVICES) {
        deviceBuf[deviceBufCount++] = { addrHash, rssi, nowMs };
    }
}

// ── Helper: compute snapshot metrics from current device buffer ───────────
static void refreshSnapshot(uint32_t nowMs) {
    evictExpired(nowMs);

    int count = deviceBufCount;
    int strongestRssi = -100;
    float rssiSum = 0.0f;
    float rssiSumSq = 0.0f;

    for (int i = 0; i < count; i++) {
        int r = deviceBuf[i].rssi;
        if (r > strongestRssi) strongestRssi = r;
        rssiSum   += (float)r;
        rssiSumSq += (float)r * (float)r;
    }

    float avgRssi = (count > 0) ? rssiSum / (float)count : -100.0f;

    float variance = 0.0f;
    if (count > 1) {
        variance = (rssiSumSq / (float)count) - (avgRssi * avgRssi);
        if (variance < 0.0f) variance = 0.0f;
    }
    float stdDev = (count > 1) ? sqrtf(variance) : 0.0f;

    // Occupancy index: saturates at BLE_OCC_SAT_COUNT devices → 100
    float raw = (float)count / (float)BLE_OCC_SAT_COUNT;
    if (raw > 1.0f) raw = 1.0f;
    int occIndex = (int)(raw * 100.0f + 0.5f);

    // Confidence equals occupancy index — no single target is configured
    float confidence = (float)occIndex;

    // EMA of strongest RSSI (α = 0.3)
    if (count > 0) {
        ble.emaRssi = 0.7f * ble.emaRssi + 0.3f * (float)strongestRssi;
    }

    ble.state           = bleScanState;
    ble.confidence      = confidence;
    ble.lastRssi        = (count > 0) ? strongestRssi : -100;
    ble.seenRecently    = (count > 0);
    ble.enabled         = bleInitOk;
    ble.rssiStdDev      = stdDev;
    ble.deviceCount     = count;
    ble.occupancyIndex  = occIndex;
    ble.avgRssi         = avgRssi;
    ble.matchedName     = EMPTY_STR;
    ble.matchedAddress  = EMPTY_STR;
    ble.targetConfigured= false;
}

// ── NimBLE scan callback ──────────────────────────────────────────────────
#if BLE_SCAN_ENABLED

class OccupancyScanCallbacks : public NimBLEAdvertisedDeviceCallbacks {
public:
    void onResult(NimBLEAdvertisedDevice* dev) override {
        int rssi = dev->getRSSI();
        if (rssi < BLE_RSSI_MIN) return;  // ignore very weak / background noise

        // Use the lower 4 bytes of the address as the hash key.
        // This intentionally discards the upper bytes so random/rotating MAC
        // addresses are still deduplicated within a scan window without
        // retaining a stable long-term identifier.
        const NimBLEAddress& addr = dev->getAddress();
        const uint8_t* raw = addr.getNative();
        uint32_t hash = ((uint32_t)raw[0])
                      | ((uint32_t)raw[1] << 8)
                      | ((uint32_t)raw[2] << 16)
                      | ((uint32_t)raw[3] << 24);

        uint32_t now = (uint32_t)millis();
        upsertDevice(hash, (int8_t)rssi, now);
    }
};

static OccupancyScanCallbacks scanCallbacks;

#endif  // BLE_SCAN_ENABLED

// ── Public API ────────────────────────────────────────────────────────────

bool blePresenceBegin() {
#if BLE_SCAN_ENABLED
    NimBLEDevice::init("");
    NimBLEScan* scan = NimBLEDevice::getScan();
    if (!scan) return false;
    scan->setAdvertisedDeviceCallbacks(&scanCallbacks, /*wantDuplicates=*/false);
    scan->setActiveScan(false);   // passive scan — do not send scan requests
    scan->setInterval(100);       // 100 ms scan interval
    scan->setWindow(99);          // 99 ms scan window (nearly continuous)
    bleInitOk = true;
    ble.enabled = true;
    Serial.println(F("[BLE] Occupancy scanner initialised"));
    return true;
#else
    bleInitOk = false;
    return false;
#endif
}

void blePresencePauseFor(unsigned long ms) {
    scanPaused   = true;
    pauseUntilMs = millis() + ms;
#if BLE_SCAN_ENABLED
    NimBLEScan* scan = NimBLEDevice::getScan();
    if (scan && scan->isScanning()) scan->stop();
#endif
    bleScanState = 0;
}

void blePresenceTick() {
#if BLE_SCAN_ENABLED
    if (!bleInitOk) return;

    uint32_t now = (uint32_t)millis();

    // Honour pause window (e.g. during TLS handshake for cloud upload)
    if (scanPaused) {
        if (now < pauseUntilMs) return;
        scanPaused = false;
    }

    NimBLEScan* scan = NimBLEDevice::getScan();
    if (!scan) return;

    bool scanning = scan->isScanning();

    if (!scanning) {
        // Check if it is time to start a new burst
        if (lastScanStartMs == 0 || (now - lastScanStartMs) >= SCAN_INTERVAL_MS) {
            lastScanStartMs = now;
            bleScanState    = 1;
            // Start a non-blocking scan; results arrive via callback
            scan->start((uint32_t)(BLE_SCAN_WINDOW_MS / 1000UL), /*async=*/true);  // NimBLE takes seconds
            Serial.println(F("[BLE] Scan started"));
        } else if (bleScanState == 1) {
            // Scan just finished
            bleScanState = 2;
            refreshSnapshot(now);
            Serial.printf("[BLE] Scan done: %d device(s) occ=%d%%\n",
                          ble.deviceCount, ble.occupancyIndex);
            bleScanState = 0;
        }
    }
#endif
}

bool blePresenceBreathReady() {
    return false;
}

BlePresenceSnapshot blePresenceGetSnapshot() {
    BlePresenceSnapshot snap = ble;
    if (!snap.matchedName)    snap.matchedName    = EMPTY_STR;
    if (!snap.matchedAddress) snap.matchedAddress = EMPTY_STR;
    return snap;
}

const char* blePresenceStateLabel(int state) {
    switch (state) {
        case 1:  return "scanning";
        case 2:  return "complete";
        default: return "idle";
    }
}
