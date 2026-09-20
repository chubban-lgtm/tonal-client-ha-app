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

const mqttHost = process.env.MQTT_HOST || "core-mosquitto";
const mqttPort = Number(process.env.MQTT_PORT || 1883);
const mqttUsername = process.env.MQTT_USERNAME || "";
const mqttPassword = process.env.MQTT_PASSWORD || "";

const DEVICE = {
  identifiers: ["tonal_client"],
  name: "Tonal Client",
  manufacturer: "Tonal",
  model: "Tonal Cloud Client"
};

let mqttReady = false;
let tonalClient = null;

const mqttClient = mqtt.connect({
  host: mqttHost,
  port: mqttPort,
  username: mqttUsername || undefined,
  password: mqttPassword || undefined,
  reconnectPeriod: 5000
});

function publish(topic, payload, retain = true) {
  mqttClient.publish(
    topic,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    {
      retain
    }
  );
}

function publishDiscovery(id, config) {
  publish(
    `homeassistant/sensor/tonal_client/${id}/config`,
    {
      unique_id: `tonal_client_${id}`,
      object_id: `tonal_client_${id}`,
      device: DEVICE,
      ...config
    }
  );
}

function publishState(id, value) {
  publish(
    `tonal_client/${id}/state`,
    String(value)
  );
}

function createCoreEntities() {
  publishDiscovery("strength_score", {
    name: "Strength Score",
    state_topic: "tonal_client/strength_score/state",
    icon: "mdi:arm-flex"
  });

  publishDiscovery("upper_strength_score", {
    name: "Upper Strength Score",
    state_topic: "tonal_client/upper_strength_score/state",
    icon: "mdi:arm-flex"
  });

  publishDiscovery("core_strength_score", {
    name: "Core Strength Score",
    state_topic: "tonal_client/core_strength_score/state",
    icon: "mdi:human"
  });

  publishDiscovery("lower_strength_score", {
    name: "Lower Strength Score",
    state_topic: "tonal_client/lower_strength_score/state",
    icon: "mdi:human-handsdown"
  });

  publishDiscovery("total_workouts", {
    name: "Total Workouts",
    state_topic: "tonal_client/total_workouts/state",
    icon: "mdi:counter"
  });

  publishDiscovery("total_volume", {
    name: "Total Volume",
    state_topic: "tonal_client/total_volume/state",
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  publishDiscovery("latest_workout", {
    name: "Latest Workout",
    state_topic: "tonal_client/latest_workout/state",
    json_attributes_topic: "tonal_client/latest_workout/attributes",
    device_class: "timestamp",
    icon: "mdi:calendar-clock"
  });

  publishDiscovery("last_sync", {
    name: "Last Sync",
    state_topic: "tonal_client/last_sync/state",
    device_class: "timestamp",
    icon: "mdi:cloud-sync"
  });

  console.log("[Tonal Client] Core MQTT Discovery entities published.");
}

function getRegionScore(scores, region) {
  if (!Array.isArray(scores)) {
    return null;
  }

  const match = scores.find(
    (item) =>
      String(item.strengthBodyRegion || "").toLowerCase() ===
      region.toLowerCase()
  );

  return match?.score ?? null;
}

function getActivityTime(activity) {
  return (
    activity?.beginTime ??
    activity?.begin_time ??
    activity?.startTime ??
    activity?.timestamp ??
    null
  );
}

function sortActivitiesNewestFirst(activities) {
  return [...activities].sort((a, b) => {
    const aTime = new Date(getActivityTime(a) || 0).getTime();
    const bTime = new Date(getActivityTime(b) || 0).getTime();

    return bTime - aTime;
  });
}

async function syncTonal() {
  if (!tonalClient || !mqttReady) {
    return;
  }

  console.log("[Tonal Client] Starting Tonal sync...");

  try {
    const [scores, statistics, activities] = await Promise.all([
      tonalClient.getCurrentStrengthScores(),
      tonalClient.getUserStatistics(),
      tonalClient.getAllWorkoutActivities()
    ]);

    const overall = getRegionScore(scores, "Overall");
    const upper = getRegionScore(scores, "Upper");
    const core = getRegionScore(scores, "Core");
    const lower = getRegionScore(scores, "Lower");

    if (overall !== null) {
      publishState("strength_score", overall);
    }

    if (upper !== null) {
      publishState("upper_strength_score", upper);
    }

    if (core !== null) {
      publishState("core_strength_score", core);
    }

    if (lower !== null) {
      publishState("lower_strength_score", lower);
    }

    const totalWorkouts =
      statistics?.workouts?.total ??
      (Array.isArray(activities) ? activities.length : null);

    const totalVolume =
      statistics?.volume?.total ?? null;

    if (totalWorkouts !== null) {
      publishState("total_workouts", totalWorkouts);
    }

    if (totalVolume !== null) {
      publishState("total_volume", totalVolume);
    }

    if (Array.isArray(activities) && activities.length > 0) {
      const latest = sortActivitiesNewestFirst(activities)[0];

      const activityId =
        latest.id ??
        latest.activityId ??
        latest.workoutActivityId ??
        null;

      const latestTime = getActivityTime(latest);

      if (latestTime) {
        publishState(
          "latest_workout",
          new Date(latestTime).toISOString()
        );
      }

      if (activityId) {
        try {
          const summary =
            await tonalClient.getFormattedWorkoutSummary(activityId);

          const movementSets = Array.isArray(summary?.movementSets)
            ? summary.movementSets
            : [];

          const totalSets = movementSets.reduce(
            (sum, movement) =>
              sum +
              (Array.isArray(movement?.sets)
                ? movement.sets.length
                : 0),
            0
          );

          const totalReps = movementSets.reduce(
            (sum, movement) =>
              sum +
              (Array.isArray(movement?.sets)
                ? movement.sets.reduce(
                    (setSum, set) =>
                      setSum + Number(set?.repCount || 0),
                    0
                  )
                : 0),
            0
          );

          const workoutVolume = movementSets.reduce(
            (sum, movement) =>
              sum + Number(movement?.totalVolume || 0),
            0
          );

          publish(
            "tonal_client/latest_workout/attributes",
            {
              activity_id: activityId,
              type:
                latest.type ??
                latest.workoutType ??
                summary?.type ??
                "Unknown",
              duration_seconds:
                summary?.duration ??
                latest.duration ??
                null,
              time_under_tension_seconds:
                summary?.timeUnderTension ??
                latest.timeUnderTension ??
                null,
              total_volume: workoutVolume,
              total_reps: totalReps,
              set_count: totalSets,
              movement_count: movementSets.length,
              movements: movementSets.map((movement) => ({
                name:
                  movement.movementName ??
                  movement.name ??
                  "Unknown",
                total_volume:
                  movement.totalVolume ?? null,
                sets: Array.isArray(movement.sets)
                  ? movement.sets.map((set) => ({
                      reps: set.repCount ?? null,
                      goal: set.repGoal ?? null,
                      weight: set.weight ?? null,
                      duration: set.duration ?? null,
                      one_rep_max: set.oneRepMax ?? null,
                      max_power: set.maxConPower ?? null,
                      volume: set.totalVolume ?? null,
                      spotter_mode:
                        set.spotterMode ?? null
                    }))
                  : []
              }))
            }
          );
        } catch (error) {
          console.error(
            "[Tonal Client] Latest workout detail ERROR:",
            error instanceof Error
              ? error.message
              : String(error)
          );
        }
      }
    }

    const now = new Date().toISOString();

    publishState("last_sync", now);

    console.log(
      `[Tonal Client] Sync complete — Strength ${overall ?? "?"}, ` +
      `Workouts ${totalWorkouts ?? "?"}, ` +
      `Volume ${totalVolume ?? "?"}`
    );
  } catch (error) {
    console.error(
      "[Tonal Client] Tonal sync ERROR:",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
}

mqttClient.on("connect", async () => {
  console.log("[Tonal Client] MQTT connected.");

  mqttReady = true;

  createCoreEntities();

  /*
   * Remove the old MQTT Discovery test entity.
   * Publishing an empty retained discovery payload tells
   * Home Assistant to remove it.
   */
  publish(
    "homeassistant/sensor/tonal_client_test/config",
    ""
  );

  if (tonalClient) {
    await syncTonal();
  }
});

mqttClient.on("offline", () => {
  mqttReady = false;
  console.log("[Tonal Client] MQTT offline.");
});

mqttClient.on("error", (error) => {
  console.error(
    "[Tonal Client] MQTT ERROR:",
    error instanceof Error
      ? error.message
      : String(error)
  );
});

try {
  console.log("[Tonal Client] Authenticating with Tonal...");

  tonalClient = await TonalClient.create({
    username: tonalEmail,
    password: tonalPassword,
    cacheDir: "/data/cache"
  });

  console.log("[Tonal Client] Tonal authentication successful.");

  if (mqttReady) {
    await syncTonal();
  }

  console.log(
    `[Tonal Client] Automatic sync every ${syncInterval} seconds.`
  );

  setInterval(
    () => syncTonal(),
    syncInterval * 1000
  );
} catch (error) {
  console.error(
    "[Tonal Client] FATAL ERROR:",
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exit(1);
}