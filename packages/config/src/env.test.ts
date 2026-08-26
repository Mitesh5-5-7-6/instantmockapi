import { describe, it, expect } from 'vitest';
import {
  assertProductionSecrets,
  productionConfigProblems,
  DEV_JWT_SECRET,
  loadEnvConfig,
  type EnvConfig,
} from './env.js';

/** A production config with everything set correctly; each test breaks one thing. */
function safeProduction(overrides: Partial<EnvConfig> = {}): EnvConfig {
  return {
    nodeEnv: 'production',
    jwtSecret: 'x'.repeat(48),
    resendApiKey: 're_live_key',
    googleClientId: 'client-id.apps.googleusercontent.com',
    googleClientSecret: 'client-secret',
    appUrl: 'https://app.instantmockapi.dev',
    ...overrides,
  } as EnvConfig;
}

describe('productionConfigProblems', () => {
  it('passes a correctly configured production environment', () => {
    expect(productionConfigProblems(safeProduction())).toEqual([]);
  });

  /**
   * The whole point of the guard. The default secret is published in this
   * repository, so anyone can mint a token for any account — a warning in a
   * deploy log is not enough, because the service would keep running.
   */
  it('rejects the published development secret', () => {
    const problems = productionConfigProblems(safeProduction({ jwtSecret: DEV_JWT_SECRET }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/development default/);
  });

  it('rejects a secret that is merely short', () => {
    const problems = productionConfigProblems(safeProduction({ jwtSecret: 'short-but-custom' }));
    expect(problems[0]).toMatch(/at least 32/);
  });

  it('reports the default secret once, not twice', () => {
    // The default happens to be under 32 characters too; reporting both the
    // "is the default" and "is too short" problems would be noise.
    expect(DEV_JWT_SECRET.length).toBeLessThan(32);
    expect(productionConfigProblems(safeProduction({ jwtSecret: DEV_JWT_SECRET }))).toHaveLength(1);
  });

  it('rejects a missing mail transport', () => {
    // Without one, signup and password reset are dead ends: the link only ever
    // reaches the log.
    expect(productionConfigProblems(safeProduction({ resendApiKey: '' }))[0]).toMatch(
      /RESEND_API_KEY/,
    );
  });

  it('rejects half-configured Google credentials', () => {
    expect(productionConfigProblems(safeProduction({ googleClientSecret: '' }))[0]).toMatch(
      /GOOGLE_CLIENT/,
    );
    expect(productionConfigProblems(safeProduction({ googleClientId: '' }))[0]).toMatch(
      /GOOGLE_CLIENT/,
    );
  });

  it('rejects a non-https app URL', () => {
    // Emailed tokens over http are readable in transit, and the auth cookie is
    // Secure so it would not be sent at all.
    expect(
      productionConfigProblems(safeProduction({ appUrl: 'http://app.example.com' }))[0],
    ).toMatch(/https/);
  });

  it('reports every problem at once', () => {
    // So one deploy attempt reveals the full list instead of one item per
    // restart.
    const problems = productionConfigProblems(
      safeProduction({
        jwtSecret: DEV_JWT_SECRET,
        resendApiKey: '',
        googleClientId: '',
        appUrl: 'http://x.example.com',
      }),
    );
    expect(problems).toHaveLength(4);
  });

  /**
   * Development has to run with nothing configured — requiring a Resend key and
   * Google credentials to start the API locally would make the repository
   * unusable on a fresh clone.
   */
  it('imposes nothing outside production', () => {
    for (const nodeEnv of ['development', 'staging'] as const) {
      expect(
        productionConfigProblems({
          nodeEnv,
          jwtSecret: DEV_JWT_SECRET,
          resendApiKey: '',
          googleClientId: '',
          googleClientSecret: '',
          appUrl: 'http://localhost:3000',
        } as EnvConfig),
      ).toEqual([]);
    }
  });
});

describe('assertProductionSecrets', () => {
  it('is silent when there is nothing wrong', () => {
    expect(() => assertProductionSecrets(safeProduction())).not.toThrow();
  });

  it('throws with every reason listed', () => {
    expect(() =>
      assertProductionSecrets(safeProduction({ jwtSecret: DEV_JWT_SECRET, resendApiKey: '' })),
    ).toThrow(/development default[\s\S]*RESEND_API_KEY/);
  });
});

describe('loadEnvConfig defaults', () => {
  it('derives webOrigin and appUrl from the web port when unset', () => {
    const config = loadEnvConfig();
    expect(config.webOrigin).toBe(`http://localhost:${config.webPort}`);
    // appUrl defaults to webOrigin: in development they are the same thing, and
    // requiring both to be set would break a fresh clone.
    expect(config.appUrl).toBe(config.webOrigin);
  });

  /**
   * 900s, not the old 3600s. `tokenVersion` is checked on refresh rather than on
   * every request, so this window is exactly how long a signed-out or
   * password-reset session can still make calls.
   */
  it('keeps the access token short-lived', () => {
    expect(loadEnvConfig().jwtExpiresIn).toBe(900);
  });

  it('ships no credentials in the defaults', () => {
    const config = loadEnvConfig();
    expect(config.resendApiKey).toBe('');
    expect(config.googleClientId).toBe('');
    expect(config.googleClientSecret).toBe('');
  });
});
