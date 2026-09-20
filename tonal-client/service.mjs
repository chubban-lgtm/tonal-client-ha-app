import fs from "node:fs";
import mqtt from "mqtt";
import TonalClient from "@dlwiest/ts-tonal-client";

console.log("[Tonal Client] Starting permanent service...");

const optionsPath = "/data/options.json";

if (!fs.existsSync(optionsPath)) {
  console.error("[Tonal Client] ERROR: /data/options.json not found.");
  process.exit(1);
}

const options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));

const tonalEmail = options.tonal_email;
const tonalPassword = options.tonal_password;
const syncInterval = Number(options.sync_interval || 21600);

if (!tonalEmail || !tonalPassword) {
  console.error("[Tonal Client] ERROR: Tonal credentials are not configured.");
  process.exit(1);
}

/*
 * MQTT test configuration.
 *
 * Home Assistant's Mosquitto app is available to other apps through
 * the internal hostname core-mosquitto.
 *
 * For this first test we're checking whether the app can connect using
 * the Supervisor-provided MQTT service environment.
 */

const mqttHost =
  process.env.MQTT_HOST ||
  process.env.MQTT_SERVER ||
  "core-mosquitto";

const mqttPort = Number(
  process.env.MQTT_PORT || 1883
);

const mqttUsername =
  process.env.MQTT_USERNAME ||
  process.env.MQTT_USER ||
  "";

const mqttPassword =
  process.env.MQTT_PASSWORD ||
  "";

console.log(`[Tonal Client] MQTT broker: ${mqttHost}:${mqttPort}`);

const mqttClient = mqtt.connect({
  host: mqttHost,
  port: mqttPort,
  username: mqttUsername || undefined,
  password: mqttPassword || undefined,
  reconnectPeriod: 5000
});

mqttClient.on("connect", async () => {
  console.log("[Tonal Client] MQTT connected.");

  const discoveryTopic =
    "homeassistant/sensor/tonal_client_test/config";

  const stateTopic =
    "tonal_client/test/state";

  const discoveryPayload = {
    name: "Tonal Client Test",
    unique_id: "tonal_client_test",
    state_topic: stateTopic,
    icon: "mdi:weight-lifter",
    device: {
      identifiers: ["tonal_client"],
      name: "Tonal Client",
      manufacturer: "Tonal",
      model: "Tonal Cloud Client"
    }
  };

  mqttClient.publish(
    discoveryTopic,
    JSON.stringify(discoveryPayload),
    {
      retain: true
    }
  );

  mqttClient.publish(
    stateTopic,
    "connected",
    {
      retain: true
    }
  );

  console.log("[Tonal Client] MQTT Discovery test sensor published.");
});

mqttClient.on("error", (error) => {
  console.error(
    "[Tonal Client] MQTT ERROR:",
    error instanceof Error ? error.message : String(error)
  );
});

async function connectTonal() {
  console.log("[Tonal Client] Authenticating with Tonal...");

  const client = await TonalClient.create({
    username: tonalEmail,
    password: tonalPassword,
    cacheDir: "/data/cache"
  });

  console.log("[Tonal Client] Tonal authentication successful.");

  return client;
}

async function syncTonal(client) {
  try {
    console.log("[Tonal Client] Starting Tonal sync...");

    const scores = await client.getCurrentStrengthScores();

    const overall =
      scores.find((item) => item.strengthBodyRegion === "Overall")?.score;

    console.log(
      `[Tonal Client] Current Strength Score: ${overall ?? "unknown"}`
    );

    console.log("[Tonal Client] Tonal sync completed.");
  } catch (error) {
    console.error(
      "[Tonal Client] Tonal sync ERROR:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

try {
  const tonalClient = await connectTonal();

  await syncTonal(tonalClient);

  console.log(
    `[Tonal Client] Sync interval: ${syncInterval} seconds`
  );

  setInterval(
    () => syncTonal(tonalClient),
    syncInterval * 1000
  );
} catch (error) {
  console.error(
    "[Tonal Client] FATAL ERROR:",
    error instanceof Error ? error.message : String(error)
  );

  process.exit(1);
}