# Firmware

This directory contains the migrated SniffMaster Pro sketch as a PlatformIO project.

## Current state

- `src/main.cpp` is the current working sketch migrated from the Arduino `.ino` file.
- `include/melody_library.h` has been moved to the standard include folder.
- `platformio.ini` contains board environments for both XIAO ESP32-S3 and XIAO ESP32-C3.

## Next refactor targets

1. Extract display code into `lib/display/`
2. Extract sensor/BSEC path into `lib/sensor/`
3. Extract BLE presence code into `lib/ble_presence/`
4. Extract cloud/web relay into `lib/cloud/`
5. Replace ad-hoc timing with a central scheduler module

## Notes

The uploaded sketch indicates the loop task stack was manually increased to 16 KB for HTTPS + JSON load, and the published portal pseudocode shows the main loop currently handles button input, BSEC sensor reads, melody ticking, BLE presence scanning, Wi-Fi maintenance, portal command polling, ML scoring, cloud sync, and display updates. That is the main architectural stability risk and should be reduced by scheduled task separation. fileciteturn14file3 fileciteturn14file11
