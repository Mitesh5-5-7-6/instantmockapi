/**
 * Builder state → builder input-source payload, shared by the manual wizard and
 * the AI review page so both produce byte-identical projects. Moved unchanged
 * out of app/new/project/page.tsx; the golden test pins its output.
 */
import type { AiProposalView, AuthConfigView, AuthMode, IpsAuthShape } from './api-types';
import { builderFieldToIPS, type BuilderEntity, type BuilderField } from './builder';
import { builderRelationToIPS, pruneForGeneration } from './relations';
import { PathIndexBuilder, type FieldPathIndex } from './error-paths';
import { configForChoice } from './auth-onboarding';
import { ipsToBuilder, type IpsLike } from './draft-schema';
import { authConfigOf, entityAuthRows } from './auth-config';

export interface SerializeInput<C> {
  entities: BuilderEntity[];
  generationConfig: C;
  authMode: AuthMode;
  protectedNames: readonly string[];
}

/**
 * Pruning is what keeps an excluded entity from failing the whole create: the
 * IPS validator rejects a relation whose target is not declared, so relations
 * into excluded entities go with them.
 */
export function serializeBuilder<C>(input: SerializeInput<C>): {
  raw: {
    entities: Record<string, unknown>[];
    generationConfig: C;
    authentication?: AuthConfigView;
  };
  pathIndex: FieldPathIndex;
} {
  const pruned = pruneForGeneration(input.entities);
  const paths = new PathIndexBuilder();

  const raw = pruned.map((entity, entityPosition) =>
    paths.at('entities', entityPosition, () => {
      paths.claim(entity.id);
      const named = entity.fields.filter((field) => field.name.trim());
      return {
        name: entity.name.trim(),
        identity: { field: 'id', style: entity.identityStyle },
        // Positions claimed while the array is built. Pruning and the
        // name filter both shift indices, so nothing about the finished
        // payload reveals which form row a given index came from.
        fields: named.map((field, offset) =>
          paths.at('fields', offset, () => {
            paths.claim(field.id);
            claimChildPaths(paths, field);
            return builderFieldToIPS(field);
          }),
        ),
        relations: entity.relations.map((relation, offset) =>
          paths.at('relations', offset, () => {
            paths.claim(relation.id);
            return builderRelationToIPS(relation);
          }),
        ),
      } as Record<string, unknown>;
    }),
  );

  /*
   * The authentication answer, stamped onto the entities.
   *
   * Stamped here rather than in the payload's `authentication` block alone,
   * because `COMBINATION` is resolved per entity — and only the pruned list
   * is sent, so an excluded entity must not carry a stamp for an entity that
   * will not exist.
   */
  const authentication = configForChoice(input.authMode);
  const withAuth =
    input.authMode === 'COMBINATION'
      ? raw.map((entity) => ({
          ...entity,
          authentication: input.protectedNames.includes(entity['name'] as string)
            ? ('PROTECTED' as const)
            : ('PUBLIC' as const),
        }))
      : raw;

  return {
    raw: {
      entities: withAuth,
      generationConfig: input.generationConfig,
      // Absent when the user declined, which is the same document a
      // pre-Phase-3 project carries — see `configForChoice`.
      ...(authentication === null ? {} : { authentication }),
    },
    pathIndex: paths.build(),
  };
}

/**
 * Claim positions for a field's nested children, recursively.
 *
 * `builderFieldToIPS` emits `children` for object and array fields, so a server
 * path can be several levels deep — `entities[0].fields[2].children[0].name`.
 * Without this those resolve only as far as their parent.
 */
export function claimChildPaths(paths: PathIndexBuilder, field: BuilderField): void {
  const named = field.children.filter((child) => child.name.trim());
  named.forEach((child, offset) => {
    paths.at('children', offset, () => {
      paths.claim(child.id);
      claimChildPaths(paths, child);
    });
  });
}

/**
 * Builder entities carry no description, so the payload loses the AI's (or the
 * user's) entity descriptions. Re-attach them by name; a renamed entity has no
 * match and simply gets none.
 */
export function attachDescriptions(
  entities: Record<string, unknown>[],
  source: readonly { name: string; description?: string }[],
): Record<string, unknown>[] {
  const byName = new Map(
    source.filter((s) => s.description).map((s) => [s.name, s.description as string]),
  );
  return entities.map((entity) => {
    const description = byName.get(entity['name'] as string);
    return description ? { ...entity, description } : entity;
  });
}

export interface ReviewSource {
  kind: 'project' | 'single';
  name: string;
  description: string;
  entities: BuilderEntity[];
  methods: string[];
  mockRecords: number;
  authMode: AuthMode | null;
  protectedNames: string[];
}

type AiDraftEntities = NonNullable<AiProposalView['draft']>['entities'];

/**
 * The review page's starting state: the saved draft if there is one, otherwise
 * the AI result with the auth question still unanswered ("always ask").
 * Auth is read through the client resolver (authConfigOf / entityAuthRows),
 * never raw, per the auth-invariant guard.
 */
export function proposalToBuilder(view: AiProposalView): ReviewSource {
  const result = view.result!;
  const draft = view.draft;
  const source = draft ?? {
    kind: view.hints.kind ?? result.recommendedKind,
    name: result.name,
    description: result.description,
    entities: result.entities as AiDraftEntities,
    generationConfig: {
      methods: result.generationConfig.methods,
      mockRecords: result.generationConfig.mockRecords,
    },
    authAnswered: false,
  };
  const rawEntities = source.entities as unknown as IpsLike['entities'];
  // ipsToBuilder hides derived fields (the identity `id`) and defaults the
  // identity style to 'int', so restore 'uuid' when the hidden field was one.
  const entities = ipsToBuilder({ entities: rawEntities } as IpsLike).map((entity, index) => {
    const original = (
      rawEntities as unknown as Array<{
        identity?: { style?: string };
        fields?: Array<{ type?: string; meta?: { identity?: boolean } }>;
      }>
    )[index];
    const identityIsUuid =
      original?.identity?.style === 'uuid' ||
      (original?.identity?.style === undefined &&
        (original?.fields ?? []).some(
          (field) => field.meta?.identity === true && field.type === 'uuid',
        ));
    return identityIsUuid ? { ...entity, identityStyle: 'uuid' as const } : entity;
  });
  const authMode = source.authAnswered
    ? authConfigOf(source as unknown as IpsAuthShape).mode
    : null;
  return {
    kind: source.kind,
    name: source.name,
    description: source.description,
    entities,
    methods: [...source.generationConfig.methods],
    mockRecords: source.generationConfig.mockRecords,
    authMode,
    protectedNames:
      authMode === 'COMBINATION'
        ? entityAuthRows(source as unknown as IpsAuthShape)
            .filter((row) => row.auth === 'PROTECTED')
            .map((row) => row.name)
        : [],
  };
}
