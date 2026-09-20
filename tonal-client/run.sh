#!/bin/sh
set -e

echo "[Tonal Client] Starting..."

export MQTT_HOST="$(bashio::services mqtt host)"
export MQTT_PORT="$(bashio::services mqtt port)"
export MQTT_USERNAME="$(bashio::services mqtt username)"
export MQTT_PASSWORD="$(bashio::services mqtt password)"

echo "[Tonal Client] MQTT service credentials loaded."

exec node /app/service.mjs