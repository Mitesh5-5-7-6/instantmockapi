/**
 * One line per request, with the fact that explains most slow ones (Phase 6 §12).
 *
 * ## The problem this exists for
 *
 * On a platform that sleeps idle instances, the same endpoint is fast most of
 * the time and occasionally very slow, and the difference is not in the request.
 * Read from outside, that is indistinguishable from an intermittently slow
 * database — and the two have opposite remedies. §12's requirement is therefore
 * not "log durations" but *make cold start distinguishable*, which needs exactly
 * one bit that no per-request measurement can supply: whether this instance had
 * served anything before.
 *
 * So `coldStart` is the point of this module, and `durationMs` is the thing it
 * qualifies. A slow request with `coldStart: true` and a small `uptimeMs` is a
 * woken instance; the same duration with `coldStart: false` is a real problem.
 *
 * ## Framework-free on purpose
 *
 * The API and the hosted runtime are separate Fastify apps and both need this.
 * Putting the shape here rather than in either one means the two emit the same
 * fields — an operator reading logs from both should not have to learn two
 * vocabularies — and keeping it free of Fastify types means `packages/shared`
 * does not grow a web-framework dependency for twenty lines. Each app supplies
 * the values from its own `onResponse` hook.
 */

import { logger, type Logger } from './logger.js';

export interface RequestLogEntry {
  /** HTTP method. */
  method: string;
  /**
   * The route **pattern**, not the path.
   *
   * `/v1/projects/:id`, never `/v1/projects/6aa1…`. A pattern groups, so slow
   * endpoints are countable; a path fragments per id and makes them invisible.
   * It also keeps project ids — and anything else a caller put in a URL — out
   * of the log, which is the other reason not to log `request.url`.
   */
  route: string;
  status: number;
  /** The correlation id the caller was given, so an error report is findable. */
  requestId: string;
  durationMs: number;
}

export interface RequestObserver {
  (entry: RequestLogEntry): void;
}

export interface RequestObserverOptions {
  /** Which service emitted this. Present so one log stream can hold both. */
  service: string;
  /**
   * Injectable so the cold-start behaviour is testable without reading stdout.
   * Defaults to the shared structured logger.
   */
  log?: Pick<Logger, 'info'>;
  /** Injectable clock, for the same reason. */
  now?: () => number;
}

/**
 * Build the per-instance observer.
 *
 * The returned function is called once per response and carries the two pieces
 * of instance state that make a duration interpretable: when this process
 * started, and whether it has answered anything yet.
 */
export function createRequestObserver(options: RequestObserverOptions): RequestObserver {
  const log = options.log ?? logger;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let served = 0;

  return (entry: RequestLogEntry): void => {
    /*
     * Incremented before the log, so exactly one request per process ever
     * reports `coldStart: true` — the first one to *finish*.
     *
     * Under concurrency the first to finish is not necessarily the first to
     * arrive, and that is the right choice anyway: a burst of requests arriving
     * at a cold instance all wait on the same wake-up, so flagging one of them
     * is enough to explain the burst, and flagging all of them would suggest
     * several cold starts happened.
     */
    served += 1;
    log.info('request', {
      service: options.service,
      method: entry.method,
      route: entry.route,
      status: entry.status,
      requestId: entry.requestId,
      durationMs: Math.round(entry.durationMs),
      coldStart: served === 1,
      /*
       * Uptime at the moment of the response, which is what turns the flag into
       * a measurement: `coldStart: true` with `uptimeMs: 900` is a wake-up,
       * while the same flag with `uptimeMs: 400000` means the instance was up
       * for six minutes before anyone called it — a different story, and one
       * worth being able to tell.
       */
      uptimeMs: now() - startedAt,
    });
  };
}
