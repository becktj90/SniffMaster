// sniffmaster_ble_presence.cpp - BLE presence detection placeholder implementation

#include "sniffmaster_ble_presence.h"

// Safe empty string constant
static const char EMPTY_STR[] = "";

// Global BLE presence snapshot with safe defaults
BlePresenceSnapshot ble = {
    .state = 0,
    .confidence = 0.0f,
    .lastRssi = -100,
    .emaRssi = -100.0f,
    .matchedName = EMPTY_STR,
    .seenRecently = false,
    .enabled = false,
    .rssiStdDev = 0.0f,
    .matchedAddress = EMPTY_STR,
    .targetConfigured = false
};

// Placeholder function implementations
void blePresencePauseFor(unsigned long ms) {
    // Placeholder: does nothing
}

void blePresenceTick() {
    // Placeholder: does nothing
}

bool blePresenceBegin() {
    // Placeholder: returns true (initialized)
    return true;
}

BlePresenceSnapshot blePresenceGetSnapshot() {
    // Return a safe copy with empty strings
    BlePresenceSnapshot snap = ble;
    // Ensure pointers are always valid
    if (!snap.matchedName) snap.matchedName = EMPTY_STR;
    if (!snap.matchedAddress) snap.matchedAddress = EMPTY_STR;
    return snap;
}

bool blePresenceBreathReady() {
    // Placeholder: returns false (not ready)
    return false;
}

const char* blePresenceStateLabel(int state) {
    // Placeholder: return a simple unknown label
    return "unknown";
}
