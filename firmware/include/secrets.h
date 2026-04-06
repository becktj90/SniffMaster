// secrets.h - WiFi, Adafruit IO, OpenAI, Blynk credentials
// Replace these with your actual credentials

#ifndef SECRETS_H
#define SECRETS_H

// WiFi credentials - array of {SSID, PASSWORD}
const char* WIFI_CREDS[][2] = {
    {"your_wifi_ssid", "your_wifi_password"}
};
#define WIFI_NUM_NETWORKS (sizeof(WIFI_CREDS) / sizeof(WIFI_CREDS[0]))

// Adafruit IO credentials
#define AIO_USERNAME "your_aio_username"
#define AIO_KEY "your_aio_key"

// OpenAI API key
#define OPENAI_API_KEY "your_openai_api_key"
#define OPENAI_MODEL "gpt-3.5-turbo"

// OpenWeatherMap API key
#define OWM_API_KEY "your_owm_api_key"

// Web dashboard
#define WEB_DASHBOARD_URL  "https://sniffmaster-web.vercel.app"
#define WEB_DASHBOARD_KEY  "64098124b3d235a8242744f9a6ac518c"

// Blynk credentials
#define BLYNK_AUTH_TOKEN "your_blynk_auth_token"

#endif