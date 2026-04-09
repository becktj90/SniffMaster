// sniffmaster_ble_presence.h - BLE presence detection
// Placeholder header for BLE presence feature

#ifndef SNIFFMASTER_BLE_PRESENCE_H
#define SNIFFMASTER_BLE_PRESENCE_H

struct BlePresenceSnapshot {
    int state;
    float confidence;
    int lastRssi;
    float emaRssi;
    const char* matchedName;
    bool seenRecently;
    bool enabled;
    float rssiStdDev;
    const char* matchedAddress;
    bool targetConfigured;
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