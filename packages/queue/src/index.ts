// @instantmockapi/queue -- Job/queue abstractions, retry policy, idempotency

export {
  QUEUE_NAME,
  getRedisConnection,
  getJobQueue,
  closeQueue,
  generateIdempotencyKey,
  enqueueGenerationJob,
  createGenerationWorker,
  AI_QUEUE_NAME,
  getAiProposalQueue,
  enqueueAiProposalJob,
  createAiProposalWorker,
  type GenerationJobPayload,
  type AiProposalJobPayload,
} from './queue.js';
