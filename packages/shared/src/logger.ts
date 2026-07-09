/**
 * Lightweight structured logger.
 *
 * Outputs JSON lines for structured logging in production,
 * human-readable format in development. All log entries carry
 * a context object for traceability (projectId, jobId, worker, etc.).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private readonly context: Record<string, unknown>;
  private readonly minLevel: LogLevel;

  constructor(context: Record<string, unknown> = {}, minLevel?: LogLevel) {
    this.context = context;
    this.minLevel = minLevel ?? ((process.env['LOG_LEVEL'] as LogLevel) || 'info');
  }

  /** Create a child logger with additional context fields. */
  child(additionalContext: Record<string, unknown>): Logger {
    return new Logger({ ...this.context, ...additionalContext }, this.minLevel);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log('warn', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log('error', message, extra);
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...(Object.keys(this.context).length > 0 || extra
        ? { context: { ...this.context, ...extra } }
        : {}),
    };

    const output = JSON.stringify(entry);

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
}

/** Default logger instance. Use `logger.child({...})` for scoped loggers. */
export const logger = new Logger();
