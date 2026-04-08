// sniffmaster_ble_presence.h - BLE presence detection and occupancy estimation

#ifndef SNIFFMASTER_BLE_PRESENCE_H
#define SNIFFMASTER_BLE_PRESENCE_H

// Maximum number of unique BLE devices tracked in the scan window
#define BLE_MAX_DEVICES 48

// BLE scan window duration in milliseconds (passive scan burst length)
#define BLE_SCAN_WINDOW_MS 4000UL

// Device expiry: entries older than this are evicted from the ring buffer
#define BLE_DEVICE_TTL_MS 30000UL

// Occupancy index saturates at this many unique devices (maps to index 100)
#define BLE_OCC_SAT_COUNT 10

// Minimum RSSI threshold — devices weaker than this are ignored (far/noise)
#define BLE_RSSI_MIN -90

struct BlePresenceSnapshot {
    int state;            // 0=idle 1=scanning 2=complete
    float confidence;     // 0–100 presence confidence derived from device count
    int lastRssi;         // strongest RSSI seen in last scan
    float emaRssi;        // exponential moving average of strongest RSSI
    const char* matchedName;
    bool seenRecently;
    bool enabled;
    float rssiStdDev;
    const char* matchedAddress;
    bool targetConfigured;

    // Occupancy fields
    int deviceCount;      // unique BLE devices observed in the rolling window
    int occupancyIndex;   // 0–100 occupancy score derived from device count + RSSI
    float avgRssi;        // average RSSI of tracked devices (dBm)
};

// Function declarations
extern void blePresencePauseFor(unsigned long ms);
extern void blePresenceTick();
extern bool blePresenceBegin();
extern BlePresenceSnapshot blePresenceGetSnapshot();
extern BlePresenceSnapshot ble;
extern bool blePresenceBreathReady();
extern const char* blePresenceStateLabel(int state);

#endif