import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

import { cliPathRequiresNode, findNodeExecutable } from '../../../utils/env';

/**
 * Grace period between process exit and the forced stdout close: buffered
 * output (e.g. the trailing result line) must drain naturally first.
 */
const STDOUT_CLOSE_GRACE_MS = 1000;

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    const { cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // The SDK only routes some script extensions through `node`; normalize the
    // remaining Node-backed paths here before Electron spawns with shell=false.
    if (command === 'node' || cliPathRequiresNode(command)) {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (command === 'node') {
        if (nodeFullPath) {
          command = nodeFullPath;
        }
      } else {
        args = [command, ...args];
        command = nodeFullPath ?? 'node';
      }
    }

    // Do not pass `signal` directly to spawn() — Obsidian's Electron runtime
    // uses a different realm for AbortSignal, causing `instanceof EventTarget`
    // checks inside Node's internals to fail. Handle abort manually instead.
    const child = spawn(command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
    });

    if (signal) {
      if (signal.aborted) {
        child.kill();
      } else {
        signal.addEventListener('abort', () => child.kill(), { once: true });
      }
    }

    // Death detection must survive orphaned descendants. The SDK learns of CLI
    // death through its stdout line stream reaching EOF (its readMessages loop
    // only surfaces exitError after the line stream ends), but a still-running
    // grandchild (background Task agent, or an orphaned tool process) inherits
    // the pipe write end and keeps it open — the 2026-09-25 incident hung a
    // live turn for hours this way. Once the CLI itself has exited, give
    // buffered output a grace period to drain, then force the stream to EOF so
    // the SDK's death detection fires and the runtime's consumer-loop error
    // path (handler.onError) can settle every active turn. push(null) is
    // required before destroy(): destroy() alone emits 'close' without 'end',
    // and the SDK's readline interface never terminates its async iterator on
    // 'close'. This also covers abort-driven deaths — the cold-start loop only
    // checks its abort flag when a message arrives, so a killed CLI with an
    // orphaned fd holder would otherwise hang it too; for restart-close
    // teardown the already-settled handlers make the late error a no-op, and
    // the consumer-replacement check discards it during crash-recovery
    // replays.
    child.on('exit', () => {
      const stdout = child.stdout;
      if (!stdout || stdout.destroyed) return;
      const timer = setTimeout(() => {
        stdout.push(null);
        stdout.destroy();
      }, STDOUT_CLOSE_GRACE_MS);
      timer.unref?.();
      stdout.once('close', () => clearTimeout(timer));
    });

    if (shouldPipeStderr && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}
