/**
 * Task storage layer for scheduled tasks.
 * Port of Claude Code's src/utils/cronTasks.ts.
 *
 * Durable tasks are persisted in .pi/scheduled_tasks.json.
 * Session tasks are held in memory and die with the process.
 *
 * ── Zosma Cowork fork additions (#300) ──────────────────────────────────────
 * - Constructor accepts optional `tasksFilePath` override (for separate Cowork
 *   task file at .pi/cowork_scheduled_tasks.json).
 * - TaskRun type + recordRun/getRuns methods persisted as .pi/task_runs/<id>.jsonl.
 * - getCompletedTasks() returns non-recurring + expired tasks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeNextCronRun } from "./cron.ts";

export type TaskType = "durable" | "session";

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string; // cron expression
  prompt: string; // message to send when fired
  type: TaskType;
  createdAt: string; // ISO timestamp
  lastRunAt?: string;
  nextRunAt?: string;
  recurring: boolean;
  /** If recurring, auto-expire after this many days of inactivity (default 7, 0 = permanent) */
  maxAgeDays: number;
  /** Session ID that created this task (for session-scoped cleanup) */
  sessionId?: string;
}

/**
 * A single run of a scheduled task.
 * Persisted as one JSON line per run in .pi/task_runs/<taskId>.jsonl.
 */
export interface TaskRun {
  /** Unique run identifier. */
  runId: string;
  /** ID of the task that fired. */
  taskId: string;
  /** The prompt that was sent when the task fired. */
  prompt: string;
  /** The response from the agent (populated after completion). */
  response?: string;
  /** Run status. */
  status: "pending" | "running" | "completed" | "failed";
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run completed/failed. */
  completedAt?: string;
  /** Session ID of the Cowork session that executed this run. */
  sessionId?: string;
}

interface DurableTaskFile {
  version: 1;
  tasks: ScheduledTask[];
}

export class CronTaskStore {
  private sessionTasks: Map<string, ScheduledTask> = new Map();
  private cwd: string;
  private tasksFilePath: string;
  private runsDir: string;
  private onFileChanged?: () => void;

  constructor(cwd: string, tasksFilePath?: string) {
    this.cwd = cwd;
    this.tasksFilePath = tasksFilePath ?? path.join(cwd, ".pi", "scheduled_tasks.json");
    this.runsDir = path.join(cwd, ".pi", "task_runs");
  }

  setOnFileChanged(cb: () => void): void {
    this.onFileChanged = cb;
  }

  getTasksFilePath(): string {
    return this.tasksFilePath;
  }

  getRunsDir(): string {
    return this.runsDir;
  }

  private ensureDir(dir?: string): void {
    const target = dir ?? path.dirname(this.tasksFilePath);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
  }

  private readDurableFile(): DurableTaskFile {
    try {
      const raw = fs.readFileSync(this.tasksFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks)) {
        return parsed as DurableTaskFile;
      }
    } catch {
      // File doesn't exist or is malformed
    }
    return { version: 1, tasks: [] };
  }

  private writeDurableFile(data: DurableTaskFile): void {
    this.ensureDir();
    fs.writeFileSync(this.tasksFilePath, JSON.stringify(data, null, 2), "utf-8");
  }

  generateId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  addTask(task: ScheduledTask): void {
    if (task.type === "session") {
      this.sessionTasks.set(task.id, task);
    } else {
      const file = this.readDurableFile();
      file.tasks.push(task);
      this.writeDurableFile(file);
    }
  }

  removeTask(taskId: string): boolean {
    if (this.sessionTasks.has(taskId)) {
      this.sessionTasks.delete(taskId);
      return true;
    }

    const file = this.readDurableFile();
    const before = file.tasks.length;
    file.tasks = file.tasks.filter((t) => t.id !== taskId);
    if (file.tasks.length < before) {
      this.writeDurableFile(file);
      return true;
    }
    return false;
  }

  getTask(taskId: string): ScheduledTask | undefined {
    const session = this.sessionTasks.get(taskId);
    if (session) return session;

    const file = this.readDurableFile();
    return file.tasks.find((t) => t.id === taskId);
  }

  getAllTasks(): ScheduledTask[] {
    const file = this.readDurableFile();
    return [...file.tasks, ...this.sessionTasks.values()];
  }

  getDurableTasks(): ScheduledTask[] {
    return this.readDurableFile().tasks;
  }

  getSessionTasks(): ScheduledTask[] {
    return [...this.sessionTasks.values()];
  }

  updateTask(taskId: string, updates: Partial<ScheduledTask>): boolean {
    const sessionTask = this.sessionTasks.get(taskId);
    if (sessionTask) {
      Object.assign(sessionTask, updates);
      return true;
    }

    const file = this.readDurableFile();
    const task = file.tasks.find((t) => t.id === taskId);
    if (task) {
      Object.assign(task, updates);
      this.writeDurableFile(file);
      return true;
    }
    return false;
  }

  /**
   * Recompute nextRunAt for a task based on its cron schedule.
   */
  refreshNextRun(taskId: string, after: Date = new Date()): void {
    const task = this.getTask(taskId);
    if (!task) return;

    const next = computeNextCronRun(task.schedule, after);
    this.updateTask(taskId, {
      nextRunAt: next ? next.toISOString() : undefined,
    });
  }

  /**
   * Reload durable tasks from disk (called when chokidar detects a file change).
   */
  reloadFromDisk(): void {
    this.onFileChanged?.();
  }

  /**
   * Get missed one-shot tasks — durable non-recurring tasks whose nextRunAt is in the past.
   */
  getMissedTasks(): ScheduledTask[] {
    const now = new Date();
    return this.getDurableTasks().filter((t) => {
      if (t.recurring) return false;
      if (!t.nextRunAt) return false;
      return new Date(t.nextRunAt) < now;
    });
  }

  /**
   * Remove expired recurring tasks (older than maxAgeDays without a run).
   */
  pruneExpired(): ScheduledTask[] {
    const now = Date.now();
    const file = this.readDurableFile();
    const pruned: ScheduledTask[] = [];

    file.tasks = file.tasks.filter((t) => {
      if (!t.recurring || t.maxAgeDays === 0) return true;

      const refTime = t.lastRunAt
        ? new Date(t.lastRunAt).getTime()
        : new Date(t.createdAt).getTime();
      const age = (now - refTime) / (1000 * 60 * 60 * 24);

      if (age > t.maxAgeDays) {
        pruned.push(t);
        return false;
      }
      return true;
    });

    if (pruned.length > 0) {
      this.writeDurableFile(file);
    }
    return pruned;
  }

  /**
   * Remove all session tasks for a specific session.
   */
  cleanupSession(sessionId: string): void {
    for (const [id, task] of this.sessionTasks) {
      if (task.sessionId === sessionId) {
        this.sessionTasks.delete(id);
      }
    }
  }

  // ── Task run recording ────────────────────────────────────────────────────

  /**
   * Record a run for a task. Appends one JSON line to
   * `.pi/task_runs/<taskId>.jsonl`.
   */
  recordRun(taskId: string, run: TaskRun): void {
    const runFile = path.join(this.runsDir, `${taskId}.jsonl`);
    this.ensureDir(this.runsDir);
    fs.appendFileSync(runFile, JSON.stringify(run) + "\n", "utf-8");
  }

  /**
   * Update an existing run record by overwriting all lines for that runId
   * in the jsonl file.
   */
  updateRun(taskId: string, runId: string, updates: Partial<TaskRun>): void {
    const runFile = path.join(this.runsDir, `${taskId}.jsonl`);
    if (!fs.existsSync(runFile)) return;

    const lines = fs.readFileSync(runFile, "utf-8").split("\n").filter(Boolean);
    const updated = lines.map((line) => {
      try {
        const run = JSON.parse(line) as TaskRun;
        if (run.runId === runId) {
          return JSON.stringify({ ...run, ...updates });
        }
      } catch {
        // Preserve malformed lines
      }
      return line;
    });
    fs.writeFileSync(runFile, updated.join("\n") + "\n", "utf-8");
  }

  /**
   * Get all runs for a task, newest first.
   */
  getRuns(taskId: string, limit = 50): TaskRun[] {
    const runFile = path.join(this.runsDir, `${taskId}.jsonl`);
    if (!fs.existsSync(runFile)) return [];

    const lines = fs.readFileSync(runFile, "utf-8").split("\n").filter(Boolean);
    const runs: TaskRun[] = [];
    for (const line of lines) {
      try {
        runs.push(JSON.parse(line) as TaskRun);
      } catch {
        // Skip malformed lines
      }
    }
    // Newest first
    runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return runs.slice(0, limit);
  }

  /**
   * Get completed (non-recurring) durable tasks — ones that have fired
   * and been removed from the active list. These are reconstructed from
   * recorded runs that have status "completed" or "failed".
   *
   * Returns the most recent distinct task runs.
   */
  getCompletedTasks(): { taskId: string; name: string; lastRun: TaskRun }[] {
    if (!fs.existsSync(this.runsDir)) return [];

    const files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith(".jsonl"));
    const completed: Map<string, { taskId: string; name: string; lastRun: TaskRun }> = new Map();

    for (const file of files) {
      const taskId = file.replace(".jsonl", "");
      // Skip active tasks (those still in the tasks file)
      if (this.getTask(taskId)) continue;

      const runs = this.getRuns(taskId, 1);
      if (runs.length === 0) continue;

      const lastRun = runs[0];
      if (lastRun.status === "completed" || lastRun.status === "failed") {
        const task = this.getTask(taskId);
        const name = task?.name ?? lastRun.prompt.slice(0, 60);
        completed.set(taskId, { taskId, name, lastRun });
      }
    }

    return Array.from(completed.values()).sort(
      (a, b) => new Date(b.lastRun.startedAt).getTime() - new Date(a.lastRun.startedAt).getTime(),
    );
  }
}
