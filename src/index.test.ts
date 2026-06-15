/**
 * Tests for pi-routines extension entry point (#300).
 *
 * Contract: the forked pi-routines runs the scheduler ONLY inside Zosma Cowork
 * (detected via globalThis.__PI_ROUTINES_ON_FIRE, set by the Cowork sidecar).
 * The pi CLI/TUI must NEVER create a scheduler — regardless of any flag/lock
 * files — so scheduled tasks never fire into the user's terminal chat and stop
 * entirely when Cowork is closed. This removes the earlier timing hole where a
 * pi session started before Cowork would run its own duplicate scheduler.
 */

import { type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a complete mock ExtensionAPI that records all registrations. */
function mockPi(): ExtensionAPI & { handlers: Map<string, (...args: unknown[]) => unknown> } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("high"),
    setThinkingLevel: vi.fn(),
    registerMessageRenderer: vi.fn(),
    handlers,
  } as unknown as ExtensionAPI & { handlers: Map<string, (...args: unknown[]) => unknown> };
}

/** Resolve the extension factory's default export. */
async function loadExtensionFactory(): Promise<ExtensionFactory> {
  const mod = await import("./index.ts");
  return mod.default;
}

/**
 * Verify a lock file at the given path. Returns true if it exists.
 */
function lockFileExists(lockPath: string): boolean {
  try {
    accessSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

describe("Cowork-active scheduler bypass (#300)", () => {
  let tmpDir: string;
  let origOnFire: unknown;
  let origLockFile: unknown;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/pi-routines-test-");
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    origOnFire = (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE;
    origLockFile = (globalThis as Record<string, unknown>).__PI_ROUTINES_LOCK_FILE;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE = origOnFire;
    (globalThis as Record<string, unknown>).__PI_ROUTINES_LOCK_FILE = origLockFile;
  });

  test("skips scheduler creation when cowork_active flag exists and __PI_ROUTINES_ON_FIRE is not set", async () => {
    // ARRANGE: Create .pi/cowork_active file, ensure __PI_ROUTINES_ON_FIRE is undefined
    writeFileSync(join(tmpDir, ".pi", "cowork_active"), "1", "utf-8");
    (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE = undefined;

    const extension = await loadExtensionFactory();
    const pi = mockPi();
    extension(pi);

    const sessionStartHandler = pi.handlers.get("session_start");
    expect(sessionStartHandler).toBeDefined();

    // ACT: Fire session_start with the temp cwd
    sessionStartHandler!({}, { cwd: tmpDir });

    // ASSERT: No CronScheduler was created — handler returned early.
    // The scheduler would have written one of these lock files if started:
    const defaultLock = join(tmpDir, ".pi", "scheduled_tasks.lock");
    const coworkLock = join(tmpDir, ".pi", "cowork_tasks.lock");
    expect(lockFileExists(defaultLock)).toBe(false);
    expect(lockFileExists(coworkLock)).toBe(false);
  });

  test("pi CLI NEVER creates a scheduler, even with no cowork flags/locks present", async () => {
    // ARRANGE: No cowork_active, no cowork_tasks.lock — a "clean" pi CLI start.
    // The OLD behavior created a scheduler here (the timing hole). The robust
    // contract: the pi CLI must still defer — routines run ONLY in Cowork.
    (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE = undefined;

    const extension = await loadExtensionFactory();
    const pi = mockPi();
    extension(pi);

    const sessionStartHandler = pi.handlers.get("session_start");
    expect(sessionStartHandler).toBeDefined();

    // ACT: Fire session_start
    sessionStartHandler!({}, { cwd: tmpDir });

    // ASSERT: No scheduler created — no lock file of either kind.
    const defaultLock = join(tmpDir, ".pi", "scheduled_tasks.lock");
    const coworkLock = join(tmpDir, ".pi", "cowork_tasks.lock");
    expect(lockFileExists(defaultLock)).toBe(false);
    expect(lockFileExists(coworkLock)).toBe(false);
  });

  test("creates scheduler when __PI_ROUTINES_ON_FIRE is set (Cowork process), even with cowork_active flag", async () => {
    // ARRANGE: cowork_active exists AND __PI_ROUTINES_ON_FIRE is set (Cowork sidecar)
    writeFileSync(join(tmpDir, ".pi", "cowork_active"), "1", "utf-8");
    (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE = async () => {};

    const extension = await loadExtensionFactory();
    const pi = mockPi();
    extension(pi);

    const sessionStartHandler = pi.handlers.get("session_start");
    expect(sessionStartHandler).toBeDefined();

    // ACT: Fire session_start
    sessionStartHandler!({}, { cwd: tmpDir });

    // ASSERT: Scheduler was created (Cowork always creates a scheduler).
    // Default lock file should exist.
    const defaultLock = join(tmpDir, ".pi", "scheduled_tasks.lock");
    expect(lockFileExists(defaultLock)).toBe(true);
  });

  test("skips scheduler when cowork_tasks.lock exists (legacy fallback) and __PI_ROUTINES_ON_FIRE is not set", async () => {
    // ARRANGE: Only cowork_tasks.lock exists (no cowork_active), simulating
    // Cowork's scheduler already running with its separate lock file.
    writeFileSync(join(tmpDir, ".pi", "cowork_tasks.lock"), JSON.stringify({ pid: 9999, sessionId: "test", acquiredAt: new Date().toISOString() }), "utf-8");
    (globalThis as Record<string, unknown>).__PI_ROUTINES_ON_FIRE = undefined;

    const extension = await loadExtensionFactory();
    const pi = mockPi();
    extension(pi);

    const sessionStartHandler = pi.handlers.get("session_start");
    expect(sessionStartHandler).toBeDefined();

    // ACT: Fire session_start
    sessionStartHandler!({}, { cwd: tmpDir });

    // ASSERT: No default lock file created (scheduler was skipped)
    const defaultLock = join(tmpDir, ".pi", "scheduled_tasks.lock");
    expect(lockFileExists(defaultLock)).toBe(false);
  });
});
