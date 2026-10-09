import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAiBlueprint, structuredAiProjectFromPrompt } from './ai-blueprint.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

describe('generateAiBlueprint', () => {
  it('creates a structured hospital model from a natural-language prompt', () => {
    const project = generateAiBlueprint(
      'Create a hospital API with patients, doctors and appointments.',
    );

    expect(project.kind).toBe('project');
    expect(project.entities.map((entity) => entity.name)).toEqual([
      'Patient',
      'Doctor',
      'Department',
      'Appointment',
    ]);
    expect(project.entities[0]?.fields.some((field) => field.name === 'email')).toBe(true);
    expect(project.entities[3]?.fields.some((field) => field.name === 'appointmentDate')).toBe(
      true,
    );
    expect(
      project.entities[0]?.relations.some((relation) => relation.target === 'Appointment'),
    ).toBe(true);
  });

  it('falls back to a generic model when the prompt is vague', () => {
    const project = generateAiBlueprint('Create a simple API.');

    expect(project.name).toBe('Simple API');
    expect(project.entities.length).toBeGreaterThanOrEqual(2);
    expect(project.entities.some((entity) => entity.name === 'User')).toBe(true);
    expect(project.generationConfig.methods).toContain('GET');
  });

  it('uses a Gemini response when a Gemini API key is configured', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    kind: 'project',
                    name: 'Hospital API',
                    description: 'Hospital management API',
                    entities: [
                      {
                        name: 'Patient',
                        fields: [
                          {
                            name: 'id',
                            type: 'uuid',
                            required: true,
                            default: null,
                            children: [],
                            validation: {},
                            meta: { identity: true },
                          },
                          {
                            name: 'name',
                            type: 'string',
                            required: true,
                            default: null,
                            children: [],
                            validation: {},
                            meta: {},
                          },
                          {
                            name: 'email',
                            type: 'email',
                            required: true,
                            default: null,
                            children: [],
                            validation: { email: true },
                            meta: {},
                          },
                        ],
                        relations: [],
                      },
                    ],
                    generationConfig: {
                      validators: ['zod'],
                      types: ['typescript'],
                      methods: ['GET', 'POST'],
                      mockRecords: 10,
                      features: { search: true, filter: true, sort: true, include: true },
                      unknownFields: 'reject',
                    },
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const project = await structuredAiProjectFromPrompt(
      'Create a hospital management API with patients, doctors and appointments.',
    );

    expect(project.name).toBe('Hospital API');
    expect(project.entities[0]?.name).toBe('Patient');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
