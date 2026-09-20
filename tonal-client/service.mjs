import fs from "node:fs";
import TonalClient from "@dlwiest/ts-tonal-client";

console.log("[Tonal Client] Diagnostic service starting...");

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

function printSection(title) {
  console.log("");
  console.log("==================================================");
  console.log(`[Tonal Client] ${title}`);
  console.log("==================================================");
}

function printData(label, data) {
  console.log(`[Tonal Client] ${label}:`);
  console.log(JSON.stringify(data, null, 2));
}

async function test(name, fn) {
  printSection(name);

  try {
    const result = await fn();
    printData("Result", result);
    return result;
  } catch (error) {
    console.error(
      `[Tonal Client] ${name} ERROR:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

try {
  console.log("[Tonal Client] Authenticating with Tonal...");

  const client = await TonalClient.create({
    username: email,
    password,
    cacheDir: "/data/cache"
  });

  console.log("[Tonal Client] Authentication successful.");

  await test("USER INFO", () =>
    client.getUserInfo()
  );

  await test("CURRENT STRENGTH SCORES", () =>
    client.getCurrentStrengthScores()
  );

  const strengthHistory = await test("STRENGTH SCORE HISTORY", () =>
    client.getStrengthScoreHistory()
  );

  await test("USER STATISTICS", () =>
    client.getUserStatistics()
  );

  await test("ACHIEVEMENT STATS", () =>
    client.getAchievementStats()
  );

  await test("ACHIEVEMENTS", () =>
    client.getAchievements()
  );

  await test("MUSCLE READINESS", () =>
    client.getMuscleReadiness()
  );

  const activities = await test("COMPLETED WORKOUT ACTIVITIES", () =>
    client.getAllWorkoutActivities()
  );

  if (Array.isArray(activities) && activities.length > 0) {
    const sorted = [...activities].sort((a, b) => {
      const aTime = new Date(
        a.beginTime ?? a.begin_time ?? a.startTime ?? 0
      ).getTime();

      const bTime = new Date(
        b.beginTime ?? b.begin_time ?? b.startTime ?? 0
      ).getTime();

      return bTime - aTime;
    });

    const latest = sorted[0];

    printSection("LATEST ACTIVITY FROM ACTIVITY LIST");
    printData("Latest activity", latest);

    const activityId =
      latest.id ??
      latest.activityId ??
      latest.workoutActivityId;

    if (activityId) {
      await test("LATEST ACTIVITY FULL DETAIL", () =>
        client.getWorkoutActivityById(activityId)
      );

      await test("LATEST ACTIVITY FORMATTED SUMMARY", () =>
        client.getFormattedWorkoutSummary(activityId)
      );
    } else {
      console.log(
        "[Tonal Client] Could not determine latest activity ID."
      );
    }
  }

  if (Array.isArray(strengthHistory) && strengthHistory.length > 0) {
    printSection("STRENGTH HISTORY SUMMARY");

    console.log(
      `[Tonal Client] Strength history entries: ${strengthHistory.length}`
    );

    console.log("[Tonal Client] First strength history entry:");
    console.log(JSON.stringify(strengthHistory[0], null, 2));

    console.log("[Tonal Client] Last strength history entry:");
    console.log(
      JSON.stringify(
        strengthHistory[strengthHistory.length - 1],
        null,
        2
      )
    );
  }

  printSection("DIAGNOSTIC COMPLETE");

  console.log(
    "[Tonal Client] Diagnostics finished. Keeping app alive for log inspection."
  );

  setInterval(() => {
    // Keep the Home Assistant app running.
  }, 60_000);

} catch (error) {
  console.error(
    "[Tonal Client] FATAL ERROR:",
    error instanceof Error ? error.message : String(error)
  );

  process.exit(1);
}
