/**
 * Hosting config generator (Worker F, doc 09 §4).
 *
 * Produces the routing/config the mock runtime interprets: entities, selected
 * methods, the IPS validation model (the safe-interpreter input — the runtime
 * never executes generated code, doc 13 §4), and a seed-store reference.
 * Worker D's seed records are loaded into `mockStores` by the orchestrator;
 * this config only points at them.
 */

import { HTTP_METHODS, type HttpMethod } from '@instantmockapi/shared';
import type { Field, InternalProjectSchema } from '@instantmockapi/ips';

export interface HostedFieldRule {
  name: string;
  type: Field['type'];
  required: boolean;
  default: unknown;
  validation: Field['validation'];
  children: HostedFieldRule[];
}

export interface HostedEntityConfig {
  name: string;
  /** URL segment: GET /p/{projectId}/{path} */
  path: string;
  methods: HttpMethod[];
  fields: HostedFieldRule[];
  seedStore: { collection: 'mockStores'; entity: string };
}

export interface HostingConfig {
  projectId: string;
  version: number;
  entities: HostedEntityConfig[];
}

function fieldRule(field: Field): HostedFieldRule {
  return {
    name: field.name,
    type: field.type,
    required: field.required,
    default: field.default,
    validation: field.validation,
    children: field.children.map(fieldRule),
  };
}

export function generateHostingConfig(ips: InternalProjectSchema): Record<string, string> {
  const chosen = new Set(ips.generationConfig.methods);
  const methods = HTTP_METHODS.filter((m) => chosen.has(m));

  const config: HostingConfig = {
    projectId: ips.projectId,
    version: ips.version,
    entities: ips.entities.map((entity) => {
      const path = entity.name.toLowerCase();
      return {
        name: entity.name,
        path,
        methods: [...methods],
        fields: entity.fields.map(fieldRule),
        seedStore: { collection: 'mockStores', entity: path },
      };
    }),
  };

  return { 'hosting.config.json': JSON.stringify(config, null, 2) };
}
