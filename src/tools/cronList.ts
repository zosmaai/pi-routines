/**
 * CronList tool — lets the LLM inspect all scheduled tasks.
 * Adapted from Claude Code's CronListTool to pi's registerTool API.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CronScheduler } from "../cronScheduler.ts";

const CronListParams = Type.Object({
  type: Type.Optional(
    Type.Union([Type.Literal("all"), Type.Literal("durable"), Type.Literal("session")], {
      description: 'Filter by task type (default: "all")',
    }),
  ),
});

type CronListInput = Static<typeof CronListParams>;

export function registerCronListTool(
  pi: ExtensionAPI,
  getScheduler: () => CronScheduler | null,
) {
  pi.registerTool({
    name: "cron_list",
    label: "List Tasks",
    description: "List all scheduled tasks, optionally filtered by type.",
    promptSnippet: "cron_list: Show all scheduled tasks",
    parameters: CronListParams,

    async execute(_toolCallId, rawParams) {
      const params = rawParams as CronListInput;
      const scheduler = getScheduler();
      if (!scheduler) {
        return {
          content: [{ type: "text" as const, text: "Scheduler is not running." }],
          details: undefined,
        };
      }

      const store = scheduler.getStore();
      const filter = params.type ?? "all";

      let tasks;
      switch (filter) {
        case "durable":
          tasks = store.getDurableTasks();
          break;
        case "session":
          tasks = store.getSessionTasks();
          break;
        default:
          tasks = store.getAllTasks();
      }

      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No scheduled tasks." }],
          details: { tasks: [] },
        };
      }

      const lines = tasks.map((t) => {
        const parts = [
          `- **${t.name}** (${t.id})`,
          `  Schedule: ${t.schedule}`,
          `  Type: ${t.type} | ${t.recurring ? "recurring" : "one-shot"}`,
          t.nextRunAt
            ? `  Next run: ${new Date(t.nextRunAt).toLocaleString()}`
            : `  Next run: not scheduled`,
          t.lastRunAt
            ? `  Last run: ${new Date(t.lastRunAt).toLocaleString()}`
            : null,
          `  Prompt: ${t.prompt.length > 80 ? t.prompt.slice(0, 80) + "..." : t.prompt}`,
        ];
        return parts.filter(Boolean).join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `**Scheduled tasks (${tasks.length}):**\n\n${lines.join("\n\n")}`,
          },
        ],
        details: { tasks },
      };
    },
  });
}
