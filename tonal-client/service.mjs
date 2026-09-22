import fs from "node:fs";
import mqtt from "mqtt";
import TonalClient from "@dlwiest/ts-tonal-client";

console.log("[Tonal Client] Starting full Home Assistant service...");

const optionsPath = "/data/options.json";

if (!fs.existsSync(optionsPath)) {
  console.error("[Tonal Client] ERROR: /data/options.json not found.");
  process.exit(1);
}

const options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));

const tonalEmail = options.tonal_email;
const tonalPassword = options.tonal_password;
const syncInterval = Number(options.sync_interval || 21600);
const workoutSyncInterval = Number(options.workout_sync_interval || 900);
const githubToken = String(options.github_token || "").trim();
const workoutRepo = String(options.workout_repo || "chubban-lgtm/toneget-workout-data").trim();
const workoutBranch = String(options.workout_branch || "main").trim() || "main";

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

const MUSCLE_SCORES = [
  ["back_strength_score", "Back Strength Score", ["back"]],
  ["biceps_strength_score", "Biceps Strength Score", ["biceps"]],
  ["chest_strength_score", "Chest Strength Score", ["chest"]],
  ["shoulders_strength_score", "Shoulders Strength Score", ["shoulders", "shoulder"]],
  ["triceps_strength_score", "Triceps Strength Score", ["triceps"]],
  ["abs_strength_score", "Abs Strength Score", ["abs", "abdominals"]],
  ["obliques_strength_score", "Obliques Strength Score", ["obliques"]],
  ["glutes_strength_score", "Glutes Strength Score", ["glutes"]],
  ["hamstrings_strength_score", "Hamstrings Strength Score", ["hamstrings"]],
  ["quads_strength_score", "Quads Strength Score", ["quads", "quadriceps"]]
];

const READINESS = [
  ["chest_readiness", "Chest Readiness", "Chest"],
  ["shoulders_readiness", "Shoulders Readiness", "Shoulders"],
  ["back_readiness", "Back Readiness", "Back"],
  ["triceps_readiness", "Triceps Readiness", "Triceps"],
  ["biceps_readiness", "Biceps Readiness", "Biceps"],
  ["abs_readiness", "Abs Readiness", "Abs"],
  ["obliques_readiness", "Obliques Readiness", "Obliques"],
  ["quads_readiness", "Quads Readiness", "Quads"],
  ["glutes_readiness", "Glutes Readiness", "Glutes"],
  ["hamstrings_readiness", "Hamstrings Readiness", "Hamstrings"],
  ["calves_readiness", "Calves Readiness", "Calves"]
];

let mqttReady = false;
let tonalClient = null;
let syncRunning = false;

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
    { retain }
  );
}

function publishDiscovery(id, config) {
  publish(
    `homeassistant/sensor/tonal_client/${id}/config`,
    JSON.stringify({
      unique_id: `tonal_client_${id}`,
      object_id: `tonal_client_${id}`,
      device: DEVICE,
      ...config
    })
  );
}

function publishState(id, value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return;
  }

  publish(`tonal_client/${id}/state`, String(value));
}

function publishAttributes(id, attributes) {
  publish(`tonal_client/${id}/attributes`, attributes);
}

function numberSensor(id, name, options = {}) {
  publishDiscovery(id, {
    name,
    state_topic: `tonal_client/${id}/state`,
    ...options
  });
}

function attributeSensor(id, name, options = {}) {
  publishDiscovery(id, {
    name,
    state_topic: `tonal_client/${id}/state`,
    json_attributes_topic: `tonal_client/${id}/attributes`,
    ...options
  });
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function round(value, decimals = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function secondsToMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round(n / 60, 1) : null;
}

function secondsToHours(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round(n / 3600, 1) : null;
}

function getRegionScore(scores, region) {
  if (!Array.isArray(scores)) {
    return null;
  }

  const aliases = {
    overall: ["overall"],
    upper: ["upper", "upper body"],
    core: ["core"],
    lower: ["lower", "lower body"]
  };

  const wanted = (aliases[normalize(region)] ?? [normalize(region)])
    .map(normalize);

  const match = scores.find((item) => {
    const values = [
      item.strengthBodyRegion,
      item.bodyRegionDisplay,
      item.bodyRegion,
      item.region
    ].map(normalize);

    return values.some((value) => wanted.includes(value));
  });

  return match?.score ?? null;
}

function findDeepScore(value, aliases, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }

  seen.add(value);

  const wanted = aliases.map(normalize);

  if (!Array.isArray(value)) {
    const names = [
      value.muscleGroup,
      value.muscleGroupName,
      value.muscle,
      value.name,
      value.strengthMuscleGroup,
      value.strengthFamily,
      value.family,
      value.bodyPart
    ]
      .filter((item) => item !== undefined && item !== null)
      .map(normalize);

    if (names.some((name) => wanted.includes(name))) {
      const score =
        value.score ??
        value.strengthScore ??
        value.value ??
        null;

      if (Number.isFinite(Number(score))) {
        return Number(score);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (wanted.includes(normalize(key))) {
        if (Number.isFinite(Number(child))) {
          return Number(child);
        }

        if (child && typeof child === "object") {
          const score =
            child.score ??
            child.strengthScore ??
            child.value ??
            null;

          if (Number.isFinite(Number(score))) {
            return Number(score);
          }
        }
      }
    }
  }

  const children = Array.isArray(value)
    ? value
    : Object.values(value);

  for (const child of children) {
    const result = findDeepScore(child, aliases, seen);

    if (result !== null) {
      return result;
    }
  }

  return null;
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
    return (
      new Date(getActivityTime(b) || 0).getTime() -
      new Date(getActivityTime(a) || 0).getTime()
    );
  });
}

function createWorkoutDataEntities() {
  numberSensor("manual_workout_count", "Manual Workout Count", { icon: "mdi:counter" });
  numberSensor("manual_total_volume", "Manual Total Volume", { unit_of_measurement: "lb", icon: "mdi:weight-pound" });
  numberSensor("manual_total_sets", "Manual Total Sets", { icon: "mdi:counter" });
  numberSensor("manual_total_reps", "Manual Total Reps", { icon: "mdi:repeat" });
  numberSensor("manual_latest_workout_volume", "Manual Latest Workout Volume", { unit_of_measurement: "lb", icon: "mdi:weight-pound" });
  numberSensor("manual_latest_workout_sets", "Manual Latest Workout Sets", { icon: "mdi:counter" });
  numberSensor("manual_latest_workout_reps", "Manual Latest Workout Reps", { icon: "mdi:repeat" });
  numberSensor("manual_latest_workout_movements", "Manual Latest Workout Movements", { icon: "mdi:weight-lifter" });

  numberSensor("legacy_total_volume", "Legacy Tonal Volume", { unit_of_measurement: "lb", icon: "mdi:archive" });
  numberSensor("combined_total_volume", "Combined Total Volume", { unit_of_measurement: "lb", icon: "mdi:weight-pound" });
  numberSensor("legacy_total_workouts", "Legacy Tonal Workouts", { icon: "mdi:archive" });
  numberSensor("combined_total_workouts", "Combined Total Workouts", { icon: "mdi:counter" });
  numberSensor("combined_average_workout_volume", "Combined Average Workout Volume", { unit_of_measurement: "lb", icon: "mdi:chart-bar" });
  numberSensor("combined_max_workout_volume", "Combined Max Workout Volume", { unit_of_measurement: "lb", icon: "mdi:trophy-outline" });
  numberSensor("combined_free_lift_workouts", "Combined Free Lift Workouts", { icon: "mdi:dumbbell" });

  attributeSensor("manual_latest_workout", "Manual Latest Workout", { icon: "mdi:weight-lifter" });
  attributeSensor("exercise_baselines", "Exercise Baselines", { icon: "mdi:dumbbell" });
  attributeSensor("legacy_baseline", "Legacy Tonal Baseline", { icon: "mdi:archive-clock" });
  attributeSensor("program_state", "Program State", { icon: "mdi:calendar-sync" });

  numberSensor("arm_relaxed", "Arm Relaxed", { unit_of_measurement: "in", icon: "mdi:tape-measure" });
  numberSensor("arm_flexed", "Arm Flexed", { unit_of_measurement: "in", icon: "mdi:arm-flex" });

  publishDiscovery("manual_workout_date", { name: "Manual Workout Date", state_topic: "tonal_client/manual_workout_date/state", icon: "mdi:calendar-check" });
  publishDiscovery("manual_latest_workout_muscles", { name: "Manual Latest Workout Muscles", state_topic: "tonal_client/manual_latest_workout_muscles/state", icon: "mdi:human-handsup" });
  publishDiscovery("arm_measurement_date", { name: "Arm Measurement Date", state_topic: "tonal_client/arm_measurement_date/state", icon: "mdi:calendar" });
  publishDiscovery("current_program", { name: "Current Program", state_topic: "tonal_client/current_program/state", icon: "mdi:clipboard-text-outline" });
  publishDiscovery("next_workout", { name: "Next Workout", state_topic: "tonal_client/next_workout/state", icon: "mdi:arrow-right-bold-circle-outline" });
  publishDiscovery("training_block", { name: "Training Block", state_topic: "tonal_client/training_block/state", icon: "mdi:calendar-range" });
  publishDiscovery("workout_data_last_sync", { name: "Workout Data Last Sync", state_topic: "tonal_client/workout_data_last_sync/state", device_class: "timestamp", icon: "mdi:github" });
}

function workoutSetVolume(exercise, set) {
  const reps = Number(set?.reps);
  if (!Number.isFinite(reps) || reps <= 0) return 0;

  const total = Number(set?.weight_total);
  if (Number.isFinite(total)) return total * reps;

  const each = Number(set?.weight_each);
  if (Number.isFinite(each)) {
    const sides = Number.isFinite(Number(set?.sides)) ? Number(set.sides) : 2;
    return each * reps * sides;
  }

  const weight = Number(set?.weight);
  if (Number.isFinite(weight)) {
    const unit = normalize(exercise?.unit);
    const multiplier = unit.includes("each") ? 2 : 1;
    return weight * reps * multiplier;
  }

  return 0;
}

function summarizeManualWorkout(workout) {
  const exercises = Array.isArray(workout?.exercises) ? workout.exercises : [];
  let volume = 0;
  let sets = 0;
  let reps = 0;

  for (const exercise of exercises) {
    const exerciseSets = Array.isArray(exercise?.sets) ? exercise.sets : [];
    sets += exerciseSets.length;

    for (const set of exerciseSets) {
      const r = Number(set?.reps);
      if (Number.isFinite(r)) reps += r;
      volume += workoutSetVolume(exercise, set);
    }
  }

  return {
    volume_lb: round(volume),
    sets,
    reps,
    movements: exercises.length
  };
}

async function githubJson(path) {
  if (!githubToken || !workoutRepo) return null;
  const url = `https://api.github.com/repos/${workoutRepo}/contents/${path}?ref=${encodeURIComponent(workoutBranch)}`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.github.raw+json", Authorization: `Bearer ${githubToken}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Tonal-Client-HA" } });
  if (!response.ok) throw new Error(`GitHub ${response.status} while reading ${path}`);
  return response.json();
}

async function syncWorkoutData() {
  if (!githubToken) {
    console.log("[Tonal Client] Workout data sync disabled: GitHub token not configured.");
    return;
  }
  try {
    const [workoutsDoc, measurementsDoc, baselinesDoc, legacyDoc, programDoc] = await Promise.all([
      githubJson("workout_data/workouts.json"),
      githubJson("workout_data/measurements.json"),
      githubJson("workout_data/exercise_baselines.json"),
      githubJson("workout_data/legacy_baseline.json"),
      githubJson("workout_data/program_state.json")
    ]);

    const workouts = Array.isArray(workoutsDoc?.workouts) ? workoutsDoc.workouts : [];
    const measurements = Array.isArray(measurementsDoc?.measurements) ? measurementsDoc.measurements : [];
    const baselines = Array.isArray(baselinesDoc?.exercises) ? baselinesDoc.exercises : [];
    const latestWorkout = workouts.at(-1) || {};
    const latestMeasurement = measurements.at(-1) || {};

    const manualSummaries = workouts.map(summarizeManualWorkout);
    const manualTotalVolume = manualSummaries.reduce((sum, item) => sum + Number(item.volume_lb || 0), 0);
    const manualTotalSets = manualSummaries.reduce((sum, item) => sum + Number(item.sets || 0), 0);
    const manualTotalReps = manualSummaries.reduce((sum, item) => sum + Number(item.reps || 0), 0);
    const latestSummary = manualSummaries.at(-1) || { volume_lb: 0, sets: 0, reps: 0, movements: 0 };

    const legacyVolume = Number(legacyDoc?.lifetime?.total_volume_lb);
    const legacyWorkouts = Number(legacyDoc?.lifetime?.total_workouts);
    const legacyMaxWorkoutVolume = Number(legacyDoc?.records_and_averages?.max_workout_volume_lb);
    const legacyFreeLift = Number(legacyDoc?.lifetime?.free_lift_workouts);

    const combinedVolume = (Number.isFinite(legacyVolume) ? legacyVolume : 0) + manualTotalVolume;
    const combinedWorkouts = (Number.isFinite(legacyWorkouts) ? legacyWorkouts : 0) + workouts.length;
    const manualMaxWorkoutVolume = manualSummaries.reduce((max, item) => Math.max(max, Number(item.volume_lb || 0)), 0);
    const combinedMaxWorkoutVolume = Math.max(Number.isFinite(legacyMaxWorkoutVolume) ? legacyMaxWorkoutVolume : 0, manualMaxWorkoutVolume);

    publishState("manual_workout_count", workouts.length);
    publishState("manual_total_volume", round(manualTotalVolume));
    publishState("manual_total_sets", manualTotalSets);
    publishState("manual_total_reps", manualTotalReps);
    publishState("manual_latest_workout_volume", latestSummary.volume_lb);
    publishState("manual_latest_workout_sets", latestSummary.sets);
    publishState("manual_latest_workout_reps", latestSummary.reps);
    publishState("manual_latest_workout_movements", latestSummary.movements);

    if (Number.isFinite(legacyVolume)) publishState("legacy_total_volume", legacyVolume);
    if (Number.isFinite(legacyWorkouts)) publishState("legacy_total_workouts", legacyWorkouts);
    publishState("combined_total_volume", round(combinedVolume));
    publishState("combined_total_workouts", combinedWorkouts);
    if (combinedWorkouts > 0) publishState("combined_average_workout_volume", round(combinedVolume / combinedWorkouts));
    publishState("combined_max_workout_volume", round(combinedMaxWorkoutVolume));
    if (Number.isFinite(legacyFreeLift)) publishState("combined_free_lift_workouts", legacyFreeLift + workouts.length);

    if (latestWorkout.date) publishState("manual_workout_date", latestWorkout.date);
    const latestFocus = Array.isArray(latestWorkout.focus)
      ? latestWorkout.focus
          .filter((item) => String(item || "").trim())
          .map((item) =>
            String(item)
              .trim()
              .replace(/\b\w/g, (char) => char.toUpperCase())
          )
      : [];
    if (latestFocus.length) {
      publishState("manual_latest_workout_muscles", latestFocus.join(" • "));
    }
    publishState("manual_latest_workout", latestWorkout.workout || latestWorkout.name || "Workout");
    publishAttributes("manual_latest_workout", { ...latestWorkout, calculated: latestSummary });

    publishState("arm_relaxed", latestMeasurement.arm_relaxed_in);
    publishState("arm_flexed", latestMeasurement.arm_flexed_in);
    if (latestMeasurement.date) publishState("arm_measurement_date", latestMeasurement.date);

    publishState("exercise_baselines", baselines.length);
    publishAttributes("exercise_baselines", { count: baselines.length, exercises: baselines });

    publishState("legacy_baseline", legacyDoc?.snapshot_date || "Tonal API");
    publishAttributes("legacy_baseline", legacyDoc || {});

    publishState("program_state", programDoc?.next_workout || programDoc?.program || "PPL A/B");
    publishAttributes("program_state", programDoc || {});
    if (programDoc?.program) publishState("current_program", programDoc.program);
    if (programDoc?.next_workout) publishState("next_workout", programDoc.next_workout);
    if (programDoc?.training_block?.name) publishState("training_block", programDoc.training_block.name);

    publishState("workout_data_last_sync", new Date().toISOString());
    console.log(
      `[Tonal Client] Private workout data sync complete — ${workouts.length} workouts, ` +
      `${round(manualTotalVolume)} lb manual volume, ${round(combinedVolume)} lb combined volume, ` +
      `${baselines.length} baselines.`
    );
  } catch (error) {
    console.error("[Tonal Client] Workout data sync ERROR:", error instanceof Error ? error.message : String(error));
  }
}

function createEntities() {
  // Core strength
  numberSensor("strength_score", "Strength Score", {
    icon: "mdi:arm-flex"
  });

  numberSensor("upper_strength_score", "Upper Strength Score", {
    icon: "mdi:arm-flex"
  });

  numberSensor("core_strength_score", "Core Strength Score", {
    icon: "mdi:human"
  });

  numberSensor("lower_strength_score", "Lower Strength Score", {
    icon: "mdi:human-handsdown"
  });

  // Muscle strength
  for (const [id, name] of MUSCLE_SCORES) {
    numberSensor(id, name, {
      icon: "mdi:arm-flex"
    });
  }

  // Lifetime volume
  numberSensor("total_volume", "Total Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("max_workout_volume", "Max Workout Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("max_weekly_volume", "Max Weekly Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("average_workout_volume", "Average Workout Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("average_weekly_volume", "Average Weekly Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  // Workout statistics
  numberSensor("total_workouts", "Total Workouts", {
    icon: "mdi:counter"
  });

  numberSensor("free_lift_workouts", "Free Lift Workouts", {
    icon: "mdi:dumbbell"
  });

  numberSensor("custom_workouts", "Custom Workouts", {
    icon: "mdi:dumbbell"
  });

  numberSensor("max_workouts_per_week", "Max Workouts Per Week", {
    icon: "mdi:calendar-week"
  });

  numberSensor("average_workouts_per_week", "Average Workouts Per Week", {
    icon: "mdi:calendar-week"
  });

  numberSensor("average_workout_duration", "Average Workout Duration", {
    unit_of_measurement: "min",
    icon: "mdi:timer-outline"
  });

  numberSensor("max_workout_duration", "Max Workout Duration", {
    unit_of_measurement: "min",
    icon: "mdi:timer-outline"
  });

  numberSensor("total_workout_time", "Total Workout Time", {
    unit_of_measurement: "h",
    icon: "mdi:timer-outline"
  });

  numberSensor("total_time_under_tension", "Total Time Under Tension", {
    unit_of_measurement: "h",
    icon: "mdi:timer-sand"
  });

  // Movement/program statistics
  numberSensor("unique_movements", "Unique Movements", {
    icon: "mdi:weight-lifter"
  });

  numberSensor("total_programs", "Total Programs", {
    icon: "mdi:clipboard-text-outline"
  });

  numberSensor("program_workouts", "Program Workouts", {
    icon: "mdi:clipboard-check-outline"
  });

  numberSensor("program_volume", "Program Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("program_time", "Program Time", {
    unit_of_measurement: "h",
    icon: "mdi:timer-outline"
  });

  // Achievements
  attributeSensor("achievements", "Achievements", {
    icon: "mdi:trophy"
  });

  // Muscle readiness
  for (const [id, name] of READINESS) {
    numberSensor(id, name, {
      unit_of_measurement: "%",
      icon: "mdi:heart-pulse"
    });
  }

  // Latest workout
  attributeSensor("latest_workout", "Latest Workout", {
    device_class: "timestamp",
    icon: "mdi:calendar-clock"
  });

  numberSensor("latest_workout_volume", "Latest Workout Volume", {
    unit_of_measurement: "lb",
    icon: "mdi:weight-pound"
  });

  numberSensor("latest_workout_reps", "Latest Workout Reps", {
    icon: "mdi:counter"
  });

  numberSensor("latest_workout_sets", "Latest Workout Sets", {
    icon: "mdi:counter"
  });

  numberSensor("latest_workout_movements", "Latest Workout Movements", {
    icon: "mdi:weight-lifter"
  });

  numberSensor("latest_workout_duration", "Latest Workout Duration", {
    unit_of_measurement: "min",
    icon: "mdi:timer-outline"
  });

  numberSensor(
    "latest_workout_time_under_tension",
    "Latest Workout Time Under Tension",
    {
      unit_of_measurement: "min",
      icon: "mdi:timer-sand"
    }
  );

  numberSensor("latest_workout_calories", "Latest Workout Calories", {
    unit_of_measurement: "kcal",
    icon: "mdi:fire"
  });

  // Historical datasets
  attributeSensor("strength_history", "Strength History", {
    icon: "mdi:chart-line"
  });

  attributeSensor("workout_history", "Workout History", {
    icon: "mdi:history"
  });

  // Sync/status
  numberSensor("workout_history_count", "Workout History Count", {
    icon: "mdi:history"
  });

  publishDiscovery("last_sync", {
    name: "Last Sync",
    state_topic: "tonal_client/last_sync/state",
    device_class: "timestamp",
    icon: "mdi:cloud-sync",
    unique_id: "tonal_client_last_sync",
    object_id: "tonal_client_last_sync",
    device: DEVICE
  });

  createWorkoutDataEntities();
  console.log("[Tonal Client] Full MQTT Discovery map published.");
}

async function syncTonal() {
  if (!tonalClient || !mqttReady || syncRunning) {
    return;
  }

  syncRunning = true;

  console.log("[Tonal Client] Starting full Tonal sync...");

  try {
    const [
      scores,
      statistics,
      achievementStats,
      achievements,
      readiness,
      strengthHistory,
      activities
    ] = await Promise.all([
      tonalClient.getCurrentStrengthScores(),
      tonalClient.getUserStatistics(),
      tonalClient.getAchievementStats(),
      tonalClient.getAchievements(),
      tonalClient.getMuscleReadiness(),
      tonalClient.getStrengthScoreHistory(),
      tonalClient.getAllWorkoutActivities()
    ]);

    // --------------------------------------------------
    // Strength Scores
    // --------------------------------------------------

    const overall = getRegionScore(scores, "Overall");
    const upper = getRegionScore(scores, "Upper");
    const core = getRegionScore(scores, "Core");
    const lower = getRegionScore(scores, "Lower");

    publishState("strength_score", round(overall));
    publishState("upper_strength_score", round(upper));
    publishState("core_strength_score", round(core));
    publishState("lower_strength_score", round(lower));

    for (const [id, , aliases] of MUSCLE_SCORES) {
      const value = findDeepScore(scores, aliases);
      publishState(id, round(value));
    }

    // --------------------------------------------------
    // Lifetime Statistics
    // --------------------------------------------------

    publishState("total_volume", statistics?.volume?.total);
    publishState(
      "max_workout_volume",
      statistics?.volume?.maxVolumeInWorkout
    );
    publishState(
      "max_weekly_volume",
      statistics?.volume?.maxVolumeInAWeek
    );
    publishState(
      "average_workout_volume",
      statistics?.volume?.avgVolumePerWorkout
    );
    publishState(
      "average_weekly_volume",
      statistics?.volume?.avgVolumePerWeek
    );

    publishState("total_workouts", statistics?.workouts?.total);
    publishState(
      "free_lift_workouts",
      statistics?.workouts?.totalFreeliftWorkouts
    );
    publishState(
      "custom_workouts",
      statistics?.workouts?.totalCustomWorkouts
    );
    publishState(
      "max_workouts_per_week",
      statistics?.workouts?.maxWorkoutsPerWeek
    );
    publishState(
      "average_workouts_per_week",
      statistics?.workouts?.avgWorkoutsPerWeek
    );

    publishState(
      "average_workout_duration",
      secondsToMinutes(statistics?.workouts?.avgWorkoutDuration)
    );

    publishState(
      "max_workout_duration",
      secondsToMinutes(statistics?.workouts?.maxWorkoutDuration)
    );

    publishState(
      "total_workout_time",
      secondsToHours(statistics?.workouts?.totalDuration)
    );

    publishState(
      "total_time_under_tension",
      secondsToHours(statistics?.workouts?.totalTimeUnderTension)
    );

    publishState("unique_movements", statistics?.movements?.total);

    publishState("total_programs", statistics?.programs?.total);
    publishState(
      "program_workouts",
      statistics?.programs?.totalProgramWorkouts
    );
    publishState(
      "program_volume",
      statistics?.programs?.totalProgramVolume
    );
    publishState(
      "program_time",
      secondsToHours(statistics?.programs?.totalDuration)
    );

    // --------------------------------------------------
    // Achievements
    // --------------------------------------------------

    const achievementList = Array.isArray(achievements)
      ? achievements
      : [];

    const nextMilestones = Array.isArray(achievementStats?.nextMilestones)
      ? achievementStats.nextMilestones
      : [];

    publishState(
      "achievements",
      achievementStats?.totalAchievements ?? achievementList.length
    );

    publishAttributes("achievements", {
      total_achievements:
        achievementStats?.totalAchievements ?? achievementList.length,

      next_milestones: nextMilestones.map((item) => ({
        name: item.name ?? null,
        description: item.shortDescription ?? item.description ?? null,
        value: item.value ?? null
      })),

      earned: achievementList.map((item) => ({
        name: item.name ?? item.achievement?.name ?? null,
        description:
          item.shortDescription ??
          item.achievement?.shortDescription ??
          null,
        earned_at:
          item.localTimestamp ??
          item.createdAt ??
          null,
        category:
          item.achievement?.achievementCategory?.name ??
          null
      }))
    });

    // --------------------------------------------------
    // Muscle Readiness
    // --------------------------------------------------

    for (const [id, , apiName] of READINESS) {
      publishState(id, readiness?.[apiName]);
    }

    // --------------------------------------------------
    // Strength History
    // --------------------------------------------------

    const strengthEntries = Array.isArray(strengthHistory)
      ? strengthHistory
      : [];

    publishState("strength_history", strengthEntries.length);

    publishAttributes("strength_history", {
      count: strengthEntries.length,

      history: strengthEntries.map((entry) => ({
        timestamp: entry.activityTime ?? null,
        overall: entry.overall ?? null,
        upper: entry.upper ?? null,
        core: entry.core ?? null,
        lower: entry.lower ?? null,
        workout_activity_id: entry.workoutActivityId ?? null
      }))
    });

    // --------------------------------------------------
    // Workout History
    // --------------------------------------------------

    const sortedActivities = Array.isArray(activities)
      ? sortActivitiesNewestFirst(activities)
      : [];

    publishState("workout_history_count", sortedActivities.length);
    publishState("workout_history", sortedActivities.length);

    /*
     * Keep this intentionally summarized.
     * Publishing all raw set activity for 174 workouts into HA attributes
     * would unnecessarily bloat Home Assistant's recorder/database.
     */
    publishAttributes("workout_history", {
      count: sortedActivities.length,

      workouts: sortedActivities.map((activity) => ({
        id: activity.id ?? null,
        timestamp: getActivityTime(activity),
        end_time: activity.endTime ?? null,
        type: activity.workoutType ?? activity.type ?? null,
        duration_seconds:
          activity.totalDuration ??
          activity.duration ??
          null,
        active_duration_seconds:
          activity.activeDuration ?? null,
        movements:
          activity.totalMovements ?? null,
        sets:
          activity.totalSets ?? null,
        reps:
          activity.totalReps ?? null,
        volume:
          activity.totalVolume ?? null,
        percent_completed:
          activity.percentCompleted ?? null
      }))
    });

    // --------------------------------------------------
    // Latest Workout
    // --------------------------------------------------

    if (sortedActivities.length > 0) {
      const latest = sortedActivities[0];

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

      let summary = null;
      let fullActivity = null;

      if (activityId) {
        try {
          [summary, fullActivity] = await Promise.all([
            tonalClient.getFormattedWorkoutSummary(activityId),
            tonalClient.getWorkoutActivityById(activityId)
          ]);
        } catch (error) {
          console.error(
            "[Tonal Client] Latest workout detail ERROR:",
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      const movementSets = Array.isArray(summary?.movementSets)
        ? summary.movementSets
        : [];

      const totalSets =
        latest.totalSets ??
        movementSets.reduce(
          (sum, movement) =>
            sum +
            (Array.isArray(movement?.sets)
              ? movement.sets.length
              : 0),
          0
        );

      const totalReps =
        latest.totalReps ??
        movementSets.reduce(
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

      const totalVolume =
        latest.totalVolume ??
        movementSets.reduce(
          (sum, movement) =>
            sum + Number(movement?.totalVolume || 0),
          0
        );

      const movementCount =
        latest.totalMovements ??
        movementSets.length;

      const durationSeconds =
        summary?.duration ??
        latest.totalDuration ??
        latest.duration ??
        null;

      const tutSeconds =
        summary?.timeUnderTension ??
        latest.activeDuration ??
        null;

      const tonalCalories = Array.isArray(fullActivity?.calories)
        ? fullActivity.calories.find(
            (item) => normalize(item.algorithm) === "tonal"
          )?.caloriesBurned
        : null;

      publishState("latest_workout_volume", totalVolume);
      publishState("latest_workout_reps", totalReps);
      publishState("latest_workout_sets", totalSets);
      publishState("latest_workout_movements", movementCount);
      publishState(
        "latest_workout_duration",
        secondsToMinutes(durationSeconds)
      );
      publishState(
        "latest_workout_time_under_tension",
        secondsToMinutes(tutSeconds)
      );
      publishState(
        "latest_workout_calories",
        round(tonalCalories, 1)
      );

      publishAttributes("latest_workout", {
        activity_id: activityId,

        workout_type:
          latest.workoutType ??
          latest.type ??
          null,

        timestamp:
          summary?.timestamp ??
          latestTime ??
          null,

        local_timestamp:
          summary?.localTimestamp ??
          null,

        end_time:
          summary?.endTime ??
          latest.endTime ??
          null,

        timezone:
          summary?.timeZone ??
          latest.timezone ??
          null,

        duration_seconds: durationSeconds,
        time_under_tension_seconds: tutSeconds,
        total_volume: totalVolume,
        total_reps: totalReps,
        set_count: totalSets,
        movement_count: movementCount,
        calories: round(tonalCalories, 1),

        completed:
          fullActivity?.completed ??
          latest.completed ??
          null,

        percent_completed:
          latest.percentCompleted ??
          null,

        is_in_program:
          summary?.isInProgram ??
          null,

        is_guided_workout:
          summary?.isGuidedWorkout ??
          null,

        movements: movementSets.map((movement) => ({
          name:
            movement.movementName ??
            movement.name ??
            "Unknown",

          movement_id:
            movement.movementId ??
            null,

          total_volume:
            movement.totalVolume ??
            null,

          reps:
            movement.reps ??
            null,

          average_weight:
            round(movement.avgWeight, 1),

          peak_power:
            round(
              movement?.bilateralMovementMetrics?.peakPower,
              1
            ),

          sets: Array.isArray(movement.sets)
            ? movement.sets.map((set) => ({
                reps: set.repCount ?? null,
                goal: set.repGoal ?? null,
                weight: set.weight ?? null,
                duration_seconds: set.duration ?? null,
                one_rep_max: set.oneRepMax ?? null,
                max_power: set.maxConPower ?? null,
                volume: set.totalVolume ?? null,
                spotter_mode: set.spotterMode ?? null,
                warm_up: set.warmUp ?? null,
                burnout: set.burnout ?? null,
                drop_set: set.dropSet ?? null,
                suggested_weight_change:
                  set.suggestedWeightChange ?? null,
                prs: set.prs ?? []
              }))
            : []
        }))
      });
    }

    // --------------------------------------------------
    // Sync complete
    // --------------------------------------------------

    const now = new Date().toISOString();

    publishState("last_sync", now);

    console.log(
      `[Tonal Client] Full sync complete — ` +
      `Strength ${round(overall) ?? "?"}, ` +
      `Workouts ${statistics?.workouts?.total ?? "?"}, ` +
      `Volume ${statistics?.volume?.total ?? "?"}, ` +
      `Achievements ${achievementStats?.totalAchievements ?? "?"}, ` +
      `History ${sortedActivities.length}`
    );
  } catch (error) {
    console.error(
      "[Tonal Client] Tonal sync ERROR:",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    syncRunning = false;
  }
}

mqttClient.on("connect", async () => {
  console.log("[Tonal Client] MQTT connected.");

  mqttReady = true;

  createEntities();

  // Clean up the old proof-of-concept discovery entity.
  publish(
    "homeassistant/sensor/tonal_client_test/config",
    ""
  );

  await syncWorkoutData();

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
    error instanceof Error ? error.message : String(error)
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
    `[Tonal Client] Tonal API sync every ${syncInterval} seconds; workout data sync every ${workoutSyncInterval} seconds.`
  );

  setInterval(
    () => syncTonal(),
    syncInterval * 1000
  );

  setInterval(
    () => syncWorkoutData(),
    workoutSyncInterval * 1000
  );
} catch (error) {
  console.error(
    "[Tonal Client] FATAL ERROR:",
    error instanceof Error ? error.message : String(error)
  );

  process.exit(1);
}