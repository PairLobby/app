//! Stopping a runtime that runs as a child process. Each runtime gets its own
//! process group, so stopping it also stops whatever it started (its MCP tool
//! server, for example) instead of leaving orphans behind.

import type {ChildProcess} from 'node:child_process';

export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/** How long a runtime has to honour an interrupt before it is stopped; tests shorten it. */
export const INTERRUPT_GRACE_MS = Number(process.env['PAIRLOBBY_INTERRUPT_GRACE_MS'] ?? 10_000);

export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        if (OWN_PROCESS_GROUP && child.pid) {
            process.kill(-child.pid, signal);
            return;
        }
    } catch {
        // The group is already gone, or the platform refused; fall back to the child alone.
    }
    child.kill(signal);
}

/** Resolves true if `done` settles within `ms`, false otherwise. */
export function within(done: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        timer.unref();
        void done.then(() => {
            clearTimeout(timer);
            resolve(true);
        }, () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

/**
 * Asks a stream-JSON runtime to interrupt its turn, then escalates until the
 * process has exited. Exit is the confirmation: with no shell tool, nothing it
 * started outlives its process group.
 */
export async function interruptProcess(child: ChildProcess, closed: Promise<void>, requestId: string, forcing: () => void = () => {}): Promise<{exited: boolean; forced: boolean}> {
    try {
        child.stdin?.write(JSON.stringify({type: 'control_request', request_id: requestId, request: {subtype: 'interrupt'}}) + '\n');
    } catch {
        // A closed stdin means the process is already ending.
    }
    if (await within(closed, INTERRUPT_GRACE_MS)) {
        return {exited: true, forced: false};
    }
    // Recorded before the signal, so whoever sees the exit knows it was forced.
    forcing();
    signalTree(child, 'SIGTERM');
    if (await within(closed, 5000)) {
        return {exited: true, forced: true};
    }
    signalTree(child, 'SIGKILL');
    return {exited: await within(closed, 5000), forced: true};
}
