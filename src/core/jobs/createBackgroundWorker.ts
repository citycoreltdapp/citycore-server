import { logger } from '@/config/logger';

interface WorkerTask {
  run: () => Promise<unknown>;
  intervalMs: number;
  runOnStart?: boolean;
}

/** Runs tasks on timers. Only one runs at a time, and a tick is skipped if another is running. */
export const createBackgroundWorker = (name: string, tasks: readonly WorkerTask[]) => {
  const timers: NodeJS.Timeout[] = [];
  let activeRun: Promise<unknown> | undefined;

  const runExclusive = (task: WorkerTask) => {
    if (activeRun) return;
    activeRun = task
      .run()
      .catch((err: unknown) => logger.error({ err, worker: name }, 'Background worker error'))
      .finally(() => {
        activeRun = undefined;
      });
  };

  return {
    start() {
      for (const task of tasks) {
        timers.push(setInterval(() => runExclusive(task), task.intervalMs));
        if (task.runOnStart) runExclusive(task);
      }
      logger.info(`${name} worker started`);
    },

    /** Stops the timers and waits for any run in progress, for a clean shutdown. */
    async stop() {
      timers.splice(0).forEach(clearInterval);
      await activeRun;
    },
  };
};
