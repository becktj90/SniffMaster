# SniffMaster Pro — Deployment Guide

## ⚠️ Critical Security Notice

**The original API key in `firmware/include/web_dashboard_config.h` has been committed to the git repository and is now visible in the git history. This key should be considered compromised.**

### Immediate Actions Required:

1. **Rotate the API key in Vercel immediately:**
   ```bash
   # Generate a new key
   openssl rand -hex 16
   
   # Update in Vercel
   vercel env add SNIFFMASTER_API_KEY <new-key>
   vercel env pull
   ```

2. **Update your firmware with the new key** (see steps below)

3. **Do not rely on the old key** for any production deployments

---

## Pre-Deployment Checklist

- [ ] Both firmware builds pass: `xiao_esp32s3` and `xiao_esp32c3`
- [ ] WiFi credentials set in `firmware/include/secrets.h`
- [ ] API key rotated and updated in `firmware/include/web_dashboard_config.h`
- [ ] Web dashboard URL matches your Vercel deployment
- [ ] `.env.local` and `.env.production` never committed to git
- [ ] `firmware/include/web_dashboard_config.h` never committed
- [ ] All external API keys set (OpenWeather, OpenAI, etc.)

---

## 1. Firmware Deployment

### Step 1: Configure Credentials

Create `firmware/include/secrets.h` from the example:

```bash
cd firmware/include
cp secrets.h.example secrets.h
```

Edit `secrets.h` with your actual credentials:
- WiFi SSID and password
- Adafruit IO credentials (if using Adafruit IO)
- OpenWeather API key
- OpenAI API key
- Blynk credentials (if using Blynk)

### Step 2: Configure Web Dashboard

Create `firmware/include/web_dashboard_config.h` from the example:

```bash
cd firmware/include
cp web_dashboard_config.h.example web_dashboard_config.h
```

Edit `web_dashboard_config.h`:

```cpp
#define WEB_DASHBOARD_URL  "https://your-vercel-app.vercel.app"
#define WEB_DASHBOARD_KEY  "your-new-api-key-from-step-1"
```

The `WEB_DASHBOARD_KEY` must match the `SNIFFMASTER_API_KEY` set in your Vercel environment.

### Step 3: Build the Firmware

```bash
cd firmware

# Optional: use virtual environment
source ../.venv/bin/activate

# Build for your target board
pio run -e xiao_esp32s3    # or xiao_esp32c3

# Verify build succeeds
# Output should show: [SUCCESS] and memory usage
```

### Step 4: Flash to Device

**Via PlatformIO (VS Code):**
1. Open `firmware/` in VS Code
2. Select the correct environment: `xiao_esp32s3` or `xiao_esp32c3`
3. Click the Upload button (→) in the status bar
4. Device should reset and begin operation

**Via CLI:**

```bash
pio run -e xiao_esp32s3 -t upload
pio device monitor  # (optional) watch serial output
```

### Step 5: Verify Firmware

After flashing:
1. Check OLED display for startup screens
2. Watch serial monitor for connection logs
3. Verify WiFi SSID appears and connects
4. Check the web dashboard for incoming data (should appear within 10 minutes)

---

## 2. Web Dashboard Deployment

### Step 1: Create Upstash Redis Database

1. Sign up at https://upstash.com (free tier available)
2. Create a new Redis database (any region)
3. Note your **REST URL** and **REST Token**

### Step 2: Deploy to Vercel

#### Option A: Via CLI (Recommended)

```bash
cd web

# Install dependencies
npm install

# Install Vercel CLI globally (if needed)
npm i -g vercel

# Create/link Vercel project
vercel

# Set environment variables
vercel env add SNIFFMASTER_API_KEY        # use your new key from firmware
vercel env add UPSTASH_REDIS_REST_URL     # from Upstash step 1
vercel env add UPSTASH_REDIS_REST_TOKEN   # from Upstash step 1

# Optional: add OpenAI for weather briefing
vercel env add OPENAI_API_KEY             # your OpenAI API key

# Deploy to production
vercel --prod

# Your dashboard is now live at: https://your-project.vercel.app
```

#### Option B: Via Vercel Web Dashboard

1. Push your code to GitHub
2. Visit https://vercel.com and import the `web/` folder
3. Set environment variables in project settings:
   - `SNIFFMASTER_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - (optional) `OPENAI_API_KEY`

### Step 3: Update Firmware with Dashboard URL

After Vercel generates your deployment URL:

```cpp
// In firmware/include/web_dashboard_config.h
#define WEB_DASHBOARD_URL  "https://your-project.vercel.app"
```

Rebuild and flash the firmware.

### Step 4: Verify Web Dashboard

1. Visit your dashboard URL in a browser
2. Wait up to 10 minutes for the first data from the device
3. You should see real-time OLED pages reflected on the dashboard
4. Check `/api/health` endpoint to verify Redis connectivity

---

## 3. Testing Deployment

### Firmware Tests

```bash
cd firmware

# Build both boards to verify no platform-specific issues
pio run -e xiao_esp32s3
pio run -e xiao_esp32c3

# Check memory usage:
# - Flash: should be < 85% for xiao_esp32s3, < 95% for xiao_esp32c3
# - RAM: should be < 50% for both
```

### Web Dashboard Tests

```bash
cd web

# Local testing
npm run dev
# Visit http://localhost:3000

# Then deploy and verify:
# - GET /api/health returns Redis connection status
# - GET /api/latest returns successful data (or 204 if no data yet)
# - POST /api/update accepts data from device (test with curl)
```

### End-to-End Test

1. Flash firmware with correct web dashboard URL and API key
2. Device boots and connects to WiFi
3. Open web dashboard in browser
4. Wait 10 minutes for first data POST
5. Verify data appears on dashboard
6. Press button on device to trigger page changes
7. Verify OLED screenshot matches web dashboard state

---

## 4. Troubleshooting

### Firmware Won't Build

```bash
# Clean build artifacts
cd firmware
rm -rf .pio/

# Rebuild from scratch
pio run -e xiao_esp32s3 -t clean
pio run -e xiao_esp32s3
```

### WiFi Won't Connect

- Check SSID and password in `firmware/include/secrets.h`
- Verify WiFi network is 2.4 GHz (not 5 GHz; ESP32 doesn't support 5 GHz)
- Check serial monitor for error messages

### Data Not Appearing on Dashboard

1. **Check firmware logs:**
   ```bash
   pio device monitor
   ```
   Look for: `sendToWebDashboard()` messages and HTTP response codes

2. **Check network connectivity:**
   - Verify device WiFi IP address in logs
   - `ping` the Vercel domain from the device's network

3. **Verify API key matches:**
   - Firmware: `web_dashboard_config.h`
   - Vercel: `SNIFFMASTER_API_KEY` environment variable
   - Must be identical (case-sensitive, hex string)

4. **Check Redis storage:**
   - Visit `/api/health` endpoint
   - Should show Redis connection status
   - If Redis is unreachable, data won't persist

5. **Check Vercel logs:**
   ```bash
   vercel logs
   ```

### "Invalid key" Error

- Verify API key in firmware exactly matches Vercel environment variable
- Check for typos or trailing spaces
- Regenerate a new key: `openssl rand -hex 16`
- Update both firmware and Vercel with identical key
- Rebuild and redeploy

---

## 5. Ongoing Maintenance

### Update Firmware

1. Keep your local `firmware/include/secrets.h` and `web_dashboard_config.h`
2. Pull latest code from `main` branch
3. Rebuild: `pio run -e xiao_esp32s3`
4. Flash: `pio run -e xiao_esp32s3 -t upload`

### Rotate API Keys (Recommended Quarterly)

1. Generate new key: `openssl rand -hex 16`
2. Update `firmware/include/web_dashboard_config.h`
3. Update Vercel: `vercel env add SNIFFMASTER_API_KEY <new-key>`
4. Rebuild and flash firmware
5. Redeploy web: `vercel --prod`

### Monitor Storage

- Redis free tier: 10k commands/day
- SniffMaster uses roughly 50-100 commands/day
- Monitor Redis usage in Upstash dashboard
- No action needed unless consistently exceeding limits

---

## Additional Resources

- [PlatformIO Docs](https://docs.platformio.org/)
- [Vercel Docs](https://vercel.com/docs)
- [Upstash Redis Docs](https://upstash.com/docs)
- [ESP32 Arduino Framework](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/)

