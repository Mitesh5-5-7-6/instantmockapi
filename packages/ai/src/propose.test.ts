import { describe, expect, it } from 'vitest';
import { newProjectGenerationConfig } from '@instantmockapi/ips';
import { proposeBlueprint, type ProposalStage } from './propose.js';
import { ProviderError } from './provider.js';
import { createScriptedProvider, fakeOutputJson } from './testing.js';

const defaults = newProjectGenerationConfig(25);
const input = { prompt: 'an API', hints: {}, responseLanguage: null };

function deps(provider: ReturnType<typeof createScriptedProvider>, stages: ProposalStage[] = []) {
  return {
    provider,
    generationDefaults: defaults,
    maxDepth: 10,
    onStage: async (stage: ProposalStage) => {
      stages.push(stage);
    },
  };
}

describe('proposeBlueprint', () => {
  it('returns a valid proposal after one call', async () => {
    const provider = createScriptedProvider(fakeOutputJson(['Thing', 'Other']));
    const stages: ProposalStage[] = [];
    const outcome = await proposeBlueprint(input, deps(provider, stages));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.geminiCalls).toBe(1);
    expect(outcome.output.entities.map((e) => e.name)).toEqual(['Thing', 'Other']);
    expect(outcome.output.generationConfig.validators).toEqual(defaults.validators);
    expect(stages).toEqual(['generating', 'validating']);
  });

  it('repairs once with the IPS errors and succeeds', async () => {
    const bad = fakeOutputJson(['Thing'], {
      entities: [{ name: 'Thing', fields: [{ name: 'id', type: 'nope' }] }],
    });
    const provider = createScriptedProvider(bad, fakeOutputJson(['Thing']));
    const stages: ProposalStage[] = [];
    const outcome = await proposeBlueprint(input, deps(provider, stages));
    expect(outcome.ok && outcome.geminiCalls).toBe(2);
    expect(stages).toEqual(['generating', 'validating', 'repairing', 'validating']);

    const repair = provider.calls[1]!;
    expect(repair.turns.map((t) => t.role)).toEqual(['user', 'model', 'user']);
    expect(repair.turns[1]!.text).toBe(bad);
    expect(repair.turns[2]!.text).toContain('entities[0].fields');
  });

  it('spends the repair on non-JSON output', async () => {
    const provider = createScriptedProvider('Sorry, I cannot.', fakeOutputJson(['Thing']));
    const outcome = await proposeBlueprint(input, deps(provider));
    expect(outcome.ok).toBe(true);
    expect(provider.calls[1]!.turns[2]!.text).toContain('(root)');
  });

  it('fails with details and raw output after an unsuccessful repair — never a third call', async () => {
    const bad = fakeOutputJson([], { entities: [] });
    const provider = createScriptedProvider(bad, bad, fakeOutputJson(['Thing']));
    const outcome = await proposeBlueprint(input, deps(provider));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('AI_GENERATION_FAILED');
    expect(outcome.failure.details.length).toBeGreaterThan(0);
    expect(outcome.rawOutput).toBe(bad);
    expect(outcome.geminiCalls).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it('rethrows transient provider errors so the queue can retry', async () => {
    const provider = createScriptedProvider(new ProviderError('transient', 'HTTP 503'));
    await expect(proposeBlueprint(input, deps(provider))).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it('maps config and blocked errors to final failures', async () => {
    const config = await proposeBlueprint(
      input,
      deps(createScriptedProvider(new ProviderError('config', 'HTTP 401'))),
    );
    expect(!config.ok && config.failure.code).toBe('AI_NOT_CONFIGURED');
    const blocked = await proposeBlueprint(
      input,
      deps(createScriptedProvider(new ProviderError('blocked', 'blocked'))),
    );
    expect(!blocked.ok && blocked.failure.code).toBe('AI_GENERATION_FAILED');
    expect(!blocked.ok && blocked.failure.message).toMatch(/blocked/i);
  });

  it('applies name precedence: user hint, then model name, then the prompt-derived fallback', async () => {
    const hinted = await proposeBlueprint(
      { ...input, hints: { name: 'My Name' } },
      deps(createScriptedProvider(fakeOutputJson(['Thing']))),
    );
    expect(hinted.ok && hinted.output.name).toBe('My Name');
    const unnamed = await proposeBlueprint(
      { ...input, prompt: 'build a gym membership API' },
      deps(createScriptedProvider(fakeOutputJson(['Thing'], { name: '' }))),
    );
    expect(unnamed.ok && unnamed.output.name).toBe('Gym Membership API');
  });

  it('validates with the requested kind when the user gave one', async () => {
    const outcome = await proposeBlueprint(
      { ...input, hints: { kind: 'single' } },
      deps(createScriptedProvider(fakeOutputJson(['A', 'B']))),
    );
    expect(outcome.ok).toBe(true);
  });

  // Domain-agnostic: whatever the domain or language, the pipeline passes the
  // model's own entities through untouched. Nothing here may depend on a domain.
  it.each([
    ['gym membership with trainers and class bookings', ['Membership', 'Trainer', 'ClassBooking']],
    ['volunteer scheduling for temple events', ['Volunteer', 'Event', 'Shift']],
    [
      'મારે hospital management API જોઈએ જેમાં patients, doctors અને appointments હોય',
      ['Patient', 'Doctor', 'Appointment'],
    ],
    ['उत्पादों और ऑर्डर के लिए एक API बनाएं', ['Item', 'Purchase']],
    ['Crea una API para gestionar reservas de hotel', ['Hotel', 'Room', 'Reservation']],
    ['mandir ke events manage karne ka API chahiye', ['Event', 'Donation']],
  ])('passes through the model entities for "%s"', async (prompt, entities) => {
    const outcome = await proposeBlueprint(
      { ...input, prompt },
      deps(createScriptedProvider(fakeOutputJson(entities))),
    );
    expect(outcome.ok && outcome.output.entities.map((e) => e.name)).toEqual(entities);
  });

  it('passes reference examples into the user turn', async () => {
    const provider = createScriptedProvider(fakeOutputJson(['Thing']));
    await proposeBlueprint(input, { ...deps(provider), examples: [{ label: 'x' }] });
    expect(provider.calls[0]!.turns[0]!.text).toContain('<reference_blueprints>');
  });
});

it('passes regenerate context into the user turn', async () => {
  const provider = createScriptedProvider(fakeOutputJson(['Thing']));
  await proposeBlueprint(
    { ...input, currentBlueprint: [{ name: 'Old' }], clarification: { answers: 'yes' } },
    deps(provider),
  );
  expect(provider.calls[0]!.turns[0]!.text).toContain('<current_blueprint>');
  expect(provider.calls[0]!.turns[0]!.text).toContain('<clarifications>');
});

it('strips authentication a model puts on entities', async () => {
  const base = JSON.parse(fakeOutputJson(['Thing'])) as { entities: object[] };
  const provider = createScriptedProvider(
    fakeOutputJson(['Thing'], {
      entities: base.entities.map((e) => ({ ...e, authentication: 'PROTECTED' })),
    }),
  );
  const outcome = await proposeBlueprint(input, deps(provider));
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  for (const entity of outcome.output.entities) {
    expect(entity).not.toHaveProperty('authentication');
  }
});
