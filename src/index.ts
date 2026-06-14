/**
 * pi-routines — Pi extension entry point.
 *
 * Wires the cron scheduler to pi's session lifecycle:
 * - session_start: create scheduler, start lock/polling/watcher
 * - session_shutdown: stop scheduler, release lock, cleanup session tasks
 * - onFire: send the task's prompt as a user message via pi.sendUserMessage
 *
 * ── Zosma Cowork integration (#300) ──────────────────────────────────────────
 * When loaded by the Cowork sidecar, the sidecar sets
 * `globalThis.__PI_ROUTINES_ON_FIRE` to an async function
 * `(task, store, runId) => Promise<void>` that routes the fire into a Cowork
 * session instead of sendUserMessage. Runs are recorded automatically.
 *
 * Both the pi CLI and Cowork share the same task file (.pi/scheduled_tasks.json)
 * and lock file (.pi/scheduled_tasks.lock) — one source of truth.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CronScheduler } from "./cronScheduler.ts";
import { CronTaskStore, type TaskRun } from "./cronTasks.ts";
import { registerCronCreateTool } from "./tools/cronCreate.ts";
import { registerCronDeleteTool } from "./tools/cronDelete.ts";
import { registerCronListTool } from "./tools/cronList.ts";
import { registerLoopCommand } from "./commands/loop.ts";

// Re-export for external use (e.g., Cowork sidecar)
export { CronScheduler, CronTaskStore };
export type { TaskRun };

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  let scheduler: CronScheduler | null = null;
  let sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const getScheduler = () => scheduler;
  const getSessionId = () => sessionId;

  // Register tools
  registerCronCreateTool(pi, getScheduler, getSessionId);
  registerCronDeleteTool(pi, getScheduler);
  registerCronListTool(pi, getScheduler);

  // Register commands
  registerLoopCommand(pi, getScheduler, getSessionId);

  pi.on("session_start", (event, ctx) => {
    // Generate a fresh session ID for each session
    sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Stop any existing scheduler (e.g., on reload)
    if (scheduler) {
      scheduler.stop();
    }

    // Check for Cowork-sidecar override of onFire
    const coworkOnFire = (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE as
      | ((task: import("./cronTasks.ts").ScheduledTask, store: CronTaskStore, runId: string) => Promise<void>)
      | undefined;

    scheduler = new CronScheduler({
      cwd: ctx.cwd,
      sessionId,
      onFire: (task) => {
        const message = [
          `[Scheduled task fired: ${task.name}]`,
          "",
          task.prompt,
        ].join("\n");

        pi.sendUserMessage(message);
      },
      onFireCallback: coworkOnFire,
      onMissedTasks: (tasks) => {
        if (tasks.length === 0) return;

        const summary = tasks
          .map(
            (t) =>
              `- ${t.name}: was scheduled for ${t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "unknown"}`,
          )
          .join("\n");

        const message = [
          `[Missed scheduled tasks detected]`,
          "",
          `The following one-shot tasks were scheduled while no pi session was running:`,
          summary,
          "",
          `Should I execute them now? Reply with the task names to run, or "skip" to dismiss.`,
        ].join("\n");

        pi.sendUserMessage(message);
      },
      onError: (err) => {
        console.error("[pi-routines] Scheduler error:", err.message);
      },
    });

    scheduler.start();
  });

  pi.on("session_shutdown", () => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
  });
};

export default extension;
