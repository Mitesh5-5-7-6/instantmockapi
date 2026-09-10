import { describe, it, expect } from 'vitest';
import { createRequestObserver, type RequestLogEntry } from './request-log.js';

/**
 * Request logging (Phase 6 §12).
 *
 * The claim worth testing is narrow and is the whole reason the module exists:
 * **exactly one request per process reports `coldStart: true`**. Everything else
 * here is field plumbing; that one bit is what makes an intermittently slow
 * endpoint diagnosable rather than a mystery, and it is the only part with
 * state that can be wrong.
 */

function sink() {
  const lines: { message: string; context: Record<string, unknown> }[] = [];
  return {
    lines,
    log: {
      info(message: string, context?: Record<string, unknown>) {
        lines.push({ message, context: context ?? {} });
      },
    },
  };
}

const entry = (over: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  method: 'GET',
  route: '/v1/projects/:id',
  status: 200,
  requestId: 'req_a1b2c3',
  durationMs: 12,
  ...over,
});

describe('createRequestObserver', () => {
  it('emits one line per response, with the fields §12 asks for', () => {
    const { lines, log } = sink();
    const observe = createRequestObserver({ service: 'api', log, now: () => 1_000 });

    observe(entry({ durationMs: 412 }));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe('request');
    expect(lines[0]!.context).toEqual({
      service: 'api',
      method: 'GET',
      route: '/v1/projects/:id',
      status: 200,
      requestId: 'req_a1b2c3',
      durationMs: 412,
      coldStart: true,
      uptimeMs: 0,
    });
  });

  /**
   * The one claim that carries the feature. A flag that stayed true would make
   * every request look like a cold start; one that started false would make the
   * real one invisible.
   */
  it('reports coldStart on the first response only', () => {
    const { lines, log } = sink();
    const observe = createRequestObserver({ service: 'api', log });

    observe(entry());
    observe(entry());
    observe(entry());

    expect(lines.map((line) => line.context['coldStart'])).toEqual([true, false, false]);
  });

  it('gives each instance its own first request', () => {
    // Two observers stand in for two processes: a fresh instance must report a
    // cold start even though another instance has been serving for hours.
    const first = sink();
    const second = sink();
    const a = createRequestObserver({ service: 'api', log: first.log });
    const b = createRequestObserver({ service: 'api', log: second.log });

    a(entry());
    a(entry());
    b(entry());

    expect(first.lines.map((l) => l.context['coldStart'])).toEqual([true, false]);
    expect(second.lines.map((l) => l.context['coldStart'])).toEqual([true]);
  });

  /**
   * `uptimeMs` is what turns the flag into a measurement — a cold start 900ms
   * after boot is a wake-up, the same flag six minutes in is a different story.
   */
  it('reports uptime at the moment of the response', () => {
    const { lines, log } = sink();
    let clock = 5_000;
    const observe = createRequestObserver({ service: 'api', log, now: () => clock });

    clock = 5_900;
    observe(entry());
    clock = 65_000;
    observe(entry());

    expect(lines[0]!.context['uptimeMs']).toBe(900);
    expect(lines[1]!.context['uptimeMs']).toBe(60_000);
  });

  it('rounds the duration, so a log line is not fifteen decimal places', () => {
    const { lines, log } = sink();
    const observe = createRequestObserver({ service: 'api', log });

    observe(entry({ durationMs: 12.3456789 }));

    expect(lines[0]!.context['durationMs']).toBe(12);
  });

  it('names the service, so one log stream can hold both apps', () => {
    const { lines, log } = sink();
    createRequestObserver({ service: 'mock-runtime', log })(entry());

    expect(lines[0]!.context['service']).toBe('mock-runtime');
  });

  /**
   * The route pattern is passed through verbatim — deliberately not derived
   * here. A caller that hands over a concrete path would put project ids in the
   * log, so the responsibility for supplying a pattern sits with the hook that
   * has Fastify's `routeOptions.url`, and this asserts nothing rewrites it.
   */
  it('logs the route it was given, never a URL it built', () => {
    const { lines, log } = sink();
    createRequestObserver({ service: 'api', log })(entry({ route: '/p/:publicId/:slug/*' }));

    expect(lines[0]!.context['route']).toBe('/p/:publicId/:slug/*');
  });
});
