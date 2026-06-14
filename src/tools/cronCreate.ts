/**
 * CronCreate tool — lets the LLM schedule a new task.
 * Adapted from Claude Code's CronCreateTool to pi's registerTool API.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseCron, computeNextCronRun } from "../cron.ts";
import type { CronScheduler } from "../cronScheduler.ts";
import type { TaskType } from "../cronTasks.ts";

const CronCreateParams = Type.Object({
  name: Type.String({ description: "Short human-readable name for the task" }),
  schedule: Type.String({
    description:
      'Cron expression (5 or 6 fields). Examples: "*/5 * * * *" (every 5 min), "0 9 * * mon-fri" (weekdays at 9am)',
  }),
  prompt: Type.String({
    description: "The message/instruction to send when the task fires",
  }),
  type: Type.Optional(
    Type.Union([Type.Literal("durable"), Type.Literal("session")], {
      description:
        'Task persistence: "durable" survives restarts (default), "session" dies with this session',
    }),
  ),
  recurring: Type.Optional(
    Type.Boolean({
      description: "Whether the task repeats (default: true)",
    }),
  ),
  maxAgeDays: Type.Optional(
    Type.Number({
      description:
        "Auto-expire recurring tasks after this many days of inactivity (default: 7, 0 = permanent)",
    }),
  ),
});

type CronCreateInput = Static<typeof CronCreateParams>;

export function registerCronCreateTool(
  pi: ExtensionAPI,
  getScheduler: () => CronScheduler | null,
  getSessionId: () => string,
) {
  pi.registerTool({
    name: "cron_create",
    label: "Schedule Task",
    description:
      "Create a scheduled task that fires on a cron schedule. The task will send its prompt as a user message when it fires.",
    promptSnippet: "cron_create: Schedule recurring or one-shot tasks using cron expressions",
    parameters: CronCreateParams,

    async execute(_toolCallId, rawParams) {
      const params = rawParams as CronCreateInput;
      const scheduler = getScheduler();
      if (!scheduler) {
        return {
          content: [{ type: "text" as const, text: "Scheduler is not running." }],
          details: undefined,
        };
      }

      try {
        parseCron(params.schedule);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }

      const store = scheduler.getStore();
      const taskType: TaskType = params.type ?? "durable";
      const recurring = params.recurring ?? true;
      const maxAgeDays = params.maxAgeDays ?? 7;

      const taskId = store.generateId();
      const now = new Date();
      const nextRun = computeNextCronRun(params.schedule, now);

      const task = {
        id: taskId,
        name: params.name,
        schedule: params.schedule,
        prompt: params.prompt,
        type: taskType,
        createdAt: now.toISOString(),
        recurring,
        maxAgeDays: recurring ? maxAgeDays : 0,
        nextRunAt: nextRun ? nextRun.toISOString() : undefined,
        sessionId: taskType === "session" ? getSessionId() : undefined,
      };

      store.addTask(task);

      const nextRunStr = nextRun
        ? nextRun.toLocaleString()
        : "could not compute";

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Created ${recurring ? "recurring" : "one-shot"} ${taskType} task:`,
              `  ID: ${taskId}`,
              `  Name: ${params.name}`,
              `  Schedule: ${params.schedule}`,
              `  Next run: ${nextRunStr}`,
              recurring && maxAgeDays > 0
                ? `  Auto-expires after ${maxAgeDays} days of inactivity`
                : null,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { taskId, nextRunAt: task.nextRunAt },
      };
    },
  });
}
