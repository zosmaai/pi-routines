/**
 * Cross-session lock for the cron scheduler.
 * Port of Claude Code's src/utils/cronTasksLock.ts.
 *
 * Ensures only one pi session in a given project directory runs the scheduler.
 * Uses a lock file (.pi/scheduled_tasks.lock) with PID-based ownership.
 * Non-owning sessions probe every 5s and take over if the owner PID is dead.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOCK_PROBE_INTERVAL_MS = 5000;

interface LockFileContent {
  pid: number;
  sessionId: string;
  acquiredAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class CronTasksLock {
  private lockFilePath: string;
  private sessionId: string;
  private pid: number;
  private isOwner = false;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private onAcquired?: () => void;
  private onLost?: () => void;

  constructor(cwd: string, sessionId: string, lockFilePath?: string) {
    this.lockFilePath = lockFilePath ?? path.join(cwd, ".pi", "scheduled_tasks.lock");
    this.sessionId = sessionId;
    this.pid = process.pid;
  }

  private ensureDir(): void {
    const dir = path.dirname(this.lockFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readLock(): LockFileContent | null {
    try {
      const raw = fs.readFileSync(this.lockFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.pid === "number" && typeof parsed.sessionId === "string") {
        return parsed as LockFileContent;
      }
    } catch {
      // File doesn't exist or is malformed
    }
    return null;
  }

  private writeLock(): void {
    this.ensureDir();
    const content: LockFileContent = {
      pid: this.pid,
      sessionId: this.sessionId,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.lockFilePath, JSON.stringify(content, null, 2), "utf-8");
  }

  private removeLock(): void {
    try {
      const current = this.readLock();
      if (current && current.pid === this.pid && current.sessionId === this.sessionId) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch {
      // Already gone
    }
  }

  /**
   * Attempt to acquire the lock. Returns true if we now own it.
   */
  tryAcquire(): boolean {
    const current = this.readLock();

    if (!current) {
      this.writeLock();
      this.isOwner = true;
      return true;
    }

    if (current.pid === this.pid && current.sessionId === this.sessionId) {
      this.isOwner = true;
      return true;
    }

    if (!isPidAlive(current.pid)) {
      this.writeLock();
      this.isOwner = true;
      return true;
    }

    this.isOwner = false;
    return false;
  }

  /**
   * Start the lock lifecycle: try to acquire, then probe periodically.
   */
  start(callbacks: { onAcquired: () => void; onLost: () => void }): void {
    this.onAcquired = callbacks.onAcquired;
    this.onLost = callbacks.onLost;

    if (this.tryAcquire()) {
      this.onAcquired();
    }

    this.probeTimer = setInterval(() => {
      const wasOwner = this.isOwner;
      const nowOwner = this.tryAcquire();

      if (!wasOwner && nowOwner) {
        this.onAcquired?.();
      } else if (wasOwner && !nowOwner) {
        this.onLost?.();
      }
    }, LOCK_PROBE_INTERVAL_MS);

    // Don't keep the process alive just for this timer
    if (this.probeTimer.unref) {
      this.probeTimer.unref();
    }
  }

  /**
   * Release the lock and stop probing.
   */
  release(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.isOwner) {
      this.removeLock();
      this.isOwner = false;
    }
  }

  getIsOwner(): boolean {
    return this.isOwner;
  }
}
