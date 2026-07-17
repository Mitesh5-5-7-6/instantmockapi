import { describe, it, expect } from 'vitest';
import { buildExecutionPlan, parseExamples, workerForArtifact } from './artifacts';

describe('buildExecutionPlan (DAG levels, doc 09 §6)', () => {
  it('splits a full generation into the three levels', () => {
    const plan = buildExecutionPlan([
      'json_schema',
      'zod',
      'yup',
      'typescript',
      'mock_data',
      'openapi',
      'postman',
      'hosted_api',
      'export_zip',
    ]);
    expect(plan.level0).toEqual(['json_schema', 'zod', 'yup', 'typescript', 'mock_data']);
    expect(plan.level1).toEqual(['openapi', 'postman', 'hosted_api']);
    expect(plan.level2).toEqual(['export_zip']);
  });

  it('handles partial selections and unknown types', () => {
    const plan = buildExecutionPlan(['zod', 'openapi', 'not-a-real-artifact']);
    expect(plan.level0).toEqual(['zod']);
    expect(plan.level1).toEqual(['openapi']);
    expect(plan.level2).toEqual([]);
  });
});

describe('workerForArtifact', () => {
  it('maps artifacts to their doc-10 workers', () => {
    expect(workerForArtifact('json_schema')).toBe('A');
    expect(workerForArtifact('zod')).toBe('B');
    expect(workerForArtifact('yup')).toBe('B');
    expect(workerForArtifact('typescript')).toBe('C');
    expect(workerForArtifact('mock_data')).toBe('D');
    expect(workerForArtifact('openapi')).toBe('E');
    expect(workerForArtifact('postman')).toBe('E');
    expect(workerForArtifact('hosted_api')).toBe('F');
    expect(workerForArtifact('export_zip')).toBe('G');
  });
});

describe('parseExamples', () => {
  it("parses Worker D's mock files into entity-keyed records", () => {
    const examples = parseExamples({
      'customer.mock.json': '[{"id":"1"},{"id":"2"}]',
      'order.mock.json': '[{"total":10}]',
      'notes.txt': 'ignored',
      'broken.mock.json': '{not json',
    });
    expect(Object.keys(examples).sort()).toEqual(['customer', 'order']);
    expect(examples['customer']).toHaveLength(2);
    expect(examples['order']?.[0]).toEqual({ total: 10 });
  });
});
