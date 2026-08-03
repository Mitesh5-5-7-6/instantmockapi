/**
 * Side-effect-free public surface of the worker app.
 *
 * index.ts is the standalone host process — it calls main() on import — so
 * embedding the generator DAG in another process (apps/api with
 * RUN_WORKER_IN_PROCESS=true) must import through here instead.
 */

export { processGenerationJob, type ProcessorDeps } from './processor.js';
