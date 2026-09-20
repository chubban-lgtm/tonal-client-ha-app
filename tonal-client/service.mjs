import fs from "node:fs";
import TonalClient from "@dlwiest/ts-tonal-client";

console.log("[Tonal Client] Service starting...");

const optionsPath = "/data/options.json";

if (!fs.existsSync(optionsPath)) {
  console.error("[Tonal Client] ERROR: /data/options.json not found.");
  process.exit(1);
}

const options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));

const email = options.tonal_email;
const password = options.tonal_password;

if (!email || !password) {
  console.error("[Tonal Client] ERROR: Tonal email/password not configured.");
  process.exit(1);
}

try {
  console.log("[Tonal Client] Authenticating with Tonal...");

  const client = await TonalClient.create({
    username: email,
    password: password,
    cacheDir: "/data/cache"
  });

  console.log("[Tonal Client] Authentication successful.");

  const user = await client.getUserInfo();

  console.log(
    `[Tonal Client] User: ${user.firstName ?? "Unknown"}`
  );

  const workouts = await client.getUserWorkouts();

  console.log(
    `[Tonal Client] Workout templates returned: ${workouts.length}`
  );

  const activities = await client.getAllWorkoutActivities();

  console.log(
    `[Tonal Client] Completed workout activities returned: ${activities.length}`
  );

  if (activities.length > 0) {
    const sorted = [...activities].sort(
      (a, b) =>
        new Date(b.beginTime).getTime() -
        new Date(a.beginTime).getTime()
    );

    const latest = sorted[0];

    console.log("[Tonal Client] Latest completed activity:");
    console.log(`  Begin: ${latest.beginTime}`);
    console.log(`  Type: ${latest.workoutType ?? "Unknown"}`);
    console.log(`  Sets: ${latest.totalSets ?? "Unknown"}`);
    console.log(`  Reps: ${latest.totalReps ?? "Unknown"}`);
    console.log(`  Volume: ${latest.totalVolume ?? "Unknown"}`);
  }

  console.log("[Tonal Client] Initial test completed successfully.");

} catch (error) {
  console.error(
    "[Tonal Client] ERROR:",
    error instanceof Error ? error.message : String(error)
  );

  process.exit(1);
}
