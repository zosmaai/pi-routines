/**
 * CronDelete tool — lets the LLM remove a scheduled task.
 * Adapted from Claude Code's CronDeleteTool to pi's registerTool API.
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CronScheduler } from "../cronScheduler.ts";

const CronDeleteParams = Type.Object({
  id: Type.String({ description: "The task ID to delete" }),
});

type CronDeleteInput = Static<typeof CronDeleteParams>;

export function registerCronDeleteTool(
  pi: ExtensionAPI,
  getScheduler: () => CronScheduler | null,
) {
  pi.registerTool({
    name: "cron_delete",
    label: "Delete Task",
    description: "Delete a scheduled task by its ID.",
    promptSnippet: "cron_delete: Remove a scheduled task by ID",
    parameters: CronDeleteParams,

    async execute(_toolCallId, rawParams) {
      const params = rawParams as CronDeleteInput;
      const scheduler = getScheduler();
      if (!scheduler) {
        return {
          content: [{ type: "text" as const, text: "Scheduler is not running." }],
          details: undefined,
        };
      }

      const store = scheduler.getStore();
      const task = store.getTask(params.id);

      if (!task) {
        return {
          content: [
            { type: "text" as const, text: `Task not found: ${params.id}` },
          ],
          details: undefined,
        };
      }

      const removed = store.removeTask(params.id);

      if (removed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted task: ${task.name} (${task.id})`,
            },
          ],
          details: { deletedTaskId: task.id },
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Failed to delete task: ${params.id}` },
        ],
        details: undefined,
      };
    },
  });
}
