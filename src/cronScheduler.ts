/**
 * Cron scheduler — polls tasks every 1s, fires when due.
 * Port of Claude Code's src/utils/cronScheduler.ts.
 *
 * Integrates chokidar file watching for hot-reload of durable tasks,
 * cross-session lock to prevent double-fire, and jitter logic.
 *
 * ── Zosma Cowork fork additions (#300) ──────────────────────────────────────
 * - `onFireCallback` option: if provided, called INSTEAD of the default
 *   `onFire` which does `sendUserMessage`. The sidecar passes this to route
 *   fires into a Cowork session instead of the pi CLI terminal.
 * - When a task fires, records a `TaskRun` with `status: "running"` before
 *   firing, then updates to `"completed"` / `"failed"` after.
 */

import { watch, type FSWatcher } from "chokidar";
import { computeNextCronRun } from "./cron.ts";
import { CronTaskStore, type ScheduledTask } from "./cronTasks.ts";
import { CronTasksLock } from "./cronTasksLock.ts";

const CHECK_INTERVAL_MS = 1000;

/**
 * Default jitter config (hardcoded from Claude Code's GrowthBook defaults).
 *
 * - Recurring tasks get forward jitter: 10% of interval, max 15 minutes
 * - One-shot tasks get backward lead near :00/:30 marks, max 90 seconds
 */
const DEFAULT_JITTER = {
  recurringFraction: 0.1,
  recurringMaxMs: 15 * 60 * 1000,
  oneShotLeadMaxMs: 90 * 1000,
};

export interface CronSchedulerOptions {
  cwd: string;
  sessionId: string;
  onFire: (task: ScheduledTask) => void;
  /**
   * Optional override: if provided, called INSTEAD of the default `onFire` so
   * the Cowork sidecar can intercept task fires and route them into a Cowork
   * session instead of the pi CLI terminal.
   *
   * The callback receives the task and store for recording runs.
   * It should return a promise that resolves when the run is complete.
   */
  onFireCallback?: (
    task: ScheduledTask,
    store: CronTaskStore,
    runId: string,
  ) => Promise<void>;
  /** Optional custom tasks file path (#300). Defaults to .pi/scheduled_tasks.json. */
  tasksFilePath?: string;
  /** Optional custom lock file path (#300). Defaults to .pi/scheduled_tasks.lock. */
  lockFilePath?: string;
  onMissedTasks?: (tasks: ScheduledTask[]) => void;
  onError?: (error: Error) => void;
}

export class CronScheduler {
  private store: CronTaskStore;
  private lock: CronTasksLock;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private onFire: (task: ScheduledTask) => void;
  private onFireCallback?: (task: ScheduledTask, store: CronTaskStore, runId: string) => Promise<void>;
  private onMissedTasks?: (tasks: ScheduledTask[]) => void;
  private onError?: (error: Error) => void;
  private running = false;
  private cwd: string;
  private sessionId: string;

  constructor(options: CronSchedulerOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.onFire = options.onFire;
    this.onFireCallback = options.onFireCallback;
    this.onMissedTasks = options.onMissedTasks;
    this.onError = options.onError;
    this.store = new CronTaskStore(this.cwd, options.tasksFilePath);
    this.lock = new CronTasksLock(this.cwd, this.sessionId, options.lockFilePath);
  }

  getStore(): CronTaskStore {
    return this.store;
  }

  /**
   * Start the scheduler: acquire lock, start polling, start file watcher.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Prune expired recurring tasks on startup
    const pruned = this.store.pruneExpired();
    if (pruned.length > 0) {
      console.log(
        `[pi-routines] Pruned ${pruned.length} expired recurring task(s)`,
      );
    }

    // Check for missed one-shot tasks
    const missed = this.store.getMissedTasks();
    if (missed.length > 0 && this.onMissedTasks) {
      this.onMissedTasks(missed);
    }

    // Refresh nextRunAt for all tasks
    for (const task of this.store.getAllTasks()) {
      if (!task.nextRunAt) {
        this.store.refreshNextRun(task.id);
      }
    }

    // Start lock lifecycle
    this.lock.start({
      onAcquired: () => {
        console.log("[pi-routines] Acquired scheduler lock");
        this.startPolling();
        this.startWatcher();
      },
      onLost: () => {
        console.log("[pi-routines] Lost scheduler lock");
        this.stopPolling();
        this.stopWatcher();
      },
    });
  }

  /**
   * Stop the scheduler: release lock, stop polling, stop file watcher.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.lock.release();
    this.stopPolling();
    this.stopWatcher();
    this.store.cleanupSession(this.sessionId);
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }, CHECK_INTERVAL_MS);

    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startWatcher(): void {
    if (this.watcher) return;

    const filePath = this.store.getTasksFilePath();
    try {
      this.watcher = watch(filePath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });

      this.watcher.on("change", () => {
        this.store.reloadFromDisk();
        // Refresh nextRunAt for any new tasks
        for (const task of this.store.getAllTasks()) {
          if (!task.nextRunAt) {
            this.store.refreshNextRun(task.id);
          }
        }
      });

      this.watcher.on("error", (err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      // Watcher setup can fail if the file/dir doesn't exist yet — that's OK
      console.log("[pi-routines] File watcher setup deferred (file not yet created)");
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
  }

  /**
   * Core tick: check all tasks, fire any that are due (with jitter applied).
   */
  private tick(): void {
    if (!this.lock.getIsOwner()) return;

    const now = new Date();
    const tasks = this.store.getAllTasks();

    for (const task of tasks) {
      if (!task.nextRunAt) continue;

      const nextRun = new Date(task.nextRunAt);
      const jitteredTime = this.applyJitter(task, nextRun);

      if (now >= jitteredTime) {
        this.fireTask(task, now);
      }
    }
  }

  /**
   * Apply jitter to a task's fire time.
   *
   * Recurring: forward jitter (delay fire by up to 10% of interval, max 15min).
   * One-shot: backward jitter near :00/:30 marks (fire up to 90s early).
   */
  private applyJitter(task: ScheduledTask, scheduledTime: Date): Date {
    if (task.recurring) {
      return this.applyRecurringJitter(task, scheduledTime);
    }
    return this.applyOneShotJitter(scheduledTime);
  }

  private applyRecurringJitter(
    task: ScheduledTask,
    scheduledTime: Date,
  ): Date {
    // Estimate interval from schedule by computing two consecutive runs
    const nextAfterScheduled = computeNextCronRun(task.schedule, scheduledTime);
    if (!nextAfterScheduled) return scheduledTime;

    const intervalMs = nextAfterScheduled.getTime() - scheduledTime.getTime();
    const jitterMs = Math.min(
      intervalMs * DEFAULT_JITTER.recurringFraction,
      DEFAULT_JITTER.recurringMaxMs,
    );

    // Use task ID hash for deterministic jitter per task
    const hash = this.hashString(task.id);
    const jitterOffset = (hash % 1000) / 1000 * jitterMs;

    return new Date(scheduledTime.getTime() + jitterOffset);
  }

  private applyOneShotJitter(scheduledTime: Date): Date {
    const minute = scheduledTime.getMinutes();
    // Apply backward lead near :00 and :30 marks
    if (minute === 0 || minute === 30) {
      const leadMs = Math.random() * DEFAULT_JITTER.oneShotLeadMaxMs;
      return new Date(scheduledTime.getTime() - leadMs);
    }
    return scheduledTime;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash);
  }

  private fireTask(task: ScheduledTask, now: Date): void {
    console.log(`[pi-routines] Firing task: ${task.name} (${task.id})`);

    // Record a run before firing
    const runId = this.store.generateRunId();
    this.store.recordRun(task.id, {
      runId,
      taskId: task.id,
      prompt: task.prompt,
      status: "pending",
      startedAt: now.toISOString(),
      sessionId: this.sessionId,
    });

    // Update last run time
    this.store.updateTask(task.id, {
      lastRunAt: now.toISOString(),
    });

    if (task.recurring) {
      // Compute next run
      this.store.refreshNextRun(task.id, now);
    } else {
      // One-shot: remove after firing
      this.store.removeTask(task.id);
    }

    if (this.onFireCallback) {
      // Sidecar-managed routing: the callback handles running the task
      // in a Cowork session and recording the result.
      // Pass the runId so the callback can update the existing run record
      // instead of creating a new one.
      this.onFireCallback(task, this.store, runId).then(
        () => {
          // If the callback didn't update the run status, mark as completed
          const runs = this.store.getRuns(task.id, 1);
          if (runs.length > 0 && runs[0].runId === runId && runs[0].status === "pending") {
            this.store.updateRun(task.id, runId, {
              status: "completed",
              completedAt: new Date().toISOString(),
            });
          }
        },
        (err) => {
          console.error(`[pi-routines] onFireCallback failed for task ${task.id}:`, err);
          this.store.updateRun(task.id, runId, {
            status: "failed",
            completedAt: new Date().toISOString(),
          });
        },
      );
    } else {
      // Default: send as user message (original pi CLI behavior)
      try {
        this.onFire(task);
        this.store.updateRun(task.id, runId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[pi-routines] onFire failed for task ${task.id}:`, err);
        this.store.updateRun(task.id, runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
      }
    }
  }
}
