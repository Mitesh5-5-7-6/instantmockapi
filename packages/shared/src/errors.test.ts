import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';

describe('AI error codes', () => {
  it('maps AI_NOT_CONFIGURED to 503', () => {
    expect(new AppError({ code: 'AI_NOT_CONFIGURED', message: 'x' }).statusCode).toBe(503);
  });
  it('maps AI_GENERATION_FAILED to 502', () => {
    expect(new AppError({ code: 'AI_GENERATION_FAILED', message: 'x' }).statusCode).toBe(502);
  });
});
