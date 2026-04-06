# SniffMaster Pro Architecture

## System overview

The web portal documents the current embedded flow as:

- `handleButton()`
- `envSensor.run()`
- `melTick()`
- `blePresenceTick()`
- `maintainWiFi()`
- `pollPortalCommand()`
- ML/post-processing on fresh data
- cloud sync and display rendering

This loop shape is why firmware stability is the first engineering priority. The stack is also documented as carrying Wi-Fi, BLE 5, OLED, BSEC2 virtual sensors, and a quantized SmellNet model on the XIAO platform. fileciteturn14file3 fileciteturn14file11

## Refactor plan

### Phase 1 — stabilize
- Gate BLE, Wi-Fi, cloud, and OLED work on explicit intervals.
- Add loop-time and free-heap telemetry.
- Add I2C timeout/recovery.

### Phase 2 — modularize
- Split the monolithic sketch into sensor/display/BLE/cloud/ML modules.
- Move secrets into local headers excluded from git.

### Phase 3 — optimize
- Reduce render churn in the dashboard.
- Move heavy cloud jobs behind queues or deferred triggers.
