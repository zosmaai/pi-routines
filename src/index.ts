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

import * as fs from "node:fs";
import * as path from "node:path";
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

    // Optional Cowork-specific lock file (separate from pi CLI's lock)
    const lockFilePath = (globalThis as Record<string, unknown>).__PI_ROUTINES_LOCK_FILE as
      | string
      | undefined;

    // ── Cowork-only scheduler gate (#300) ───────────────────────────────
    // This forked pi-routines runs the scheduler ONLY inside Zosma Cowork.
    // Cowork's sidecar sets globalThis.__PI_ROUTINES_ON_FIRE; the pi CLI/TUI
    // never does. So if it's unset we are the pi CLI: NEVER create a scheduler.
    //
    // This is deliberately NOT gated on cowork_active / cowork_tasks.lock
    // files: those are timing- and cleanup-dependent (a pi session started
    // before Cowork, or stale lock files, would otherwise run a duplicate
    // scheduler that fires tasks into the terminal). Keying purely on the
    // in-process onFire override means routines run iff Cowork's process runs,
    // and stop the moment Cowork is closed.
    if (!coworkOnFire) {
      console.log(
        "[pi-routines] Not running inside Cowork — scheduler disabled (routines run only in Zosma Cowork)",
      );
      return;
    }

    scheduler = new CronScheduler({
      cwd: ctx.cwd,
      sessionId,
      lockFilePath,
      onFire: (task) => {
        // If Cowork's lock file exists, its scheduler is running.
        // The pi CLI defers so tasks fire inside Cowork instead of
        // the terminal. Cowork's own process uses onFireCallback
        // instead of onFire, so this check only applies to the CLI.
        if (!lockFilePath) {
          const coworkLockPath = path.join(ctx.cwd, ".pi", "cowork_tasks.lock");
          try {
            fs.accessSync(coworkLockPath, fs.constants.F_OK);
            console.log(
              `[pi-routines] Cowork is active — deferring "${task.name}"`,
            );
            return;
          } catch {
            // No Cowork lock — fire normally
          }
        }

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
