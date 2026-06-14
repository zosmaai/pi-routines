/**
 * /loop command — schedule a recurring task from natural-language interval + immediate execution.
 * Port of Claude Code's loop.ts skill adapted to pi's registerCommand API.
 *
 * Usage: /loop <interval> <prompt>
 * Examples:
 *   /loop 5m check git status
 *   /loop 1h run the test suite
 *   /loop 30s ping healthcheck endpoint
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseInterval, intervalToCron, computeNextCronRun } from "../cron.ts";
import type { CronScheduler } from "../cronScheduler.ts";

export function registerLoopCommand(
  pi: ExtensionAPI,
  getScheduler: () => CronScheduler | null,
  getSessionId: () => string,
) {
  pi.registerCommand("loop", {
    description: "Schedule a recurring task: /loop <interval> <prompt>",

    async handler(args, ctx) {
      const scheduler = getScheduler();
      if (!scheduler) {
        ctx.ui.notify("Scheduler is not running.", "error");
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /loop <interval> <prompt>", "warning");
        return;
      }

      // Parse: first token is the interval, rest is the prompt
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) {
        ctx.ui.notify(
          "Usage: /loop <interval> <prompt>\nExample: /loop 5m check git status",
          "warning",
        );
        return;
      }

      const intervalStr = trimmed.slice(0, spaceIdx);
      const prompt = trimmed.slice(spaceIdx + 1).trim();

      if (!prompt) {
        ctx.ui.notify("Please provide a prompt after the interval.", "warning");
        return;
      }

      const intervalMs = parseInterval(intervalStr);
      if (intervalMs === null) {
        ctx.ui.notify(
          `Could not parse interval: "${intervalStr}"\nSupported formats: 30s, 5m, 1h, 2d`,
          "error",
        );
        return;
      }

      const cronExpr = intervalToCron(intervalMs);
      if (!cronExpr) {
        ctx.ui.notify(
          `Interval too small to convert to cron: "${intervalStr}"`,
          "error",
        );
        return;
      }

      // Create the recurring task
      const store = scheduler.getStore();
      const taskId = store.generateId();
      const now = new Date();
      const nextRun = computeNextCronRun(cronExpr, now);

      const truncatedPrompt =
        prompt.length > 40 ? prompt.slice(0, 40) + "..." : prompt;
      const name = `loop: ${truncatedPrompt}`;

      store.addTask({
        id: taskId,
        name,
        schedule: cronExpr,
        prompt,
        type: "session",
        createdAt: now.toISOString(),
        recurring: true,
        maxAgeDays: 0,
        nextRunAt: nextRun ? nextRun.toISOString() : undefined,
        sessionId: getSessionId(),
      });

      ctx.ui.notify(
        `Scheduled recurring task every ${intervalStr} (cron: ${cronExpr})\nNext run: ${nextRun ? nextRun.toLocaleString() : "unknown"}`,
        "info",
      );

      // Execute immediately as the first run
      pi.sendUserMessage(prompt);
    },
  });
}
