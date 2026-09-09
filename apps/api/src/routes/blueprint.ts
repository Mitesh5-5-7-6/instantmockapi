/**
 * Blueprint export (Phase 4 §11, §12, §17, §24).
 *
 * One read. The body **is** the file: `buildBlueprint`'s output is returned
 * bare rather than wrapped in an envelope, so the thing a user downloads is
 * byte-for-byte the thing the API returned. A `{ blueprint: … }` wrapper would
 * mean the client had to unwrap before saving, and a client that forgot would
 * produce a file this API's own importer rejects.
 *
 * The blueprint is self-describing — `blueprintVersion` and `schemaVersion` are
 * the first two keys — so it needs no envelope to be identifiable.
 *
 * ## Nothing here decides what a blueprint contains
 *
 * The route reads the project, hands its definition to `buildBlueprint`, and
 * returns the result. Every rule about what may and may not travel lives in
 * `packages/ips/src/blueprint.ts`, next to the rules that read one back — which
 * is what keeps the two halves of a round trip from disagreeing.
 *
 * The signing key needs no handling: it lives in `MockAuthSecret`, a collection
 * this route never queries and whose own docstring names this exporter as the
 * reason it is a separate collection. A secret that is not on the document
 * cannot be serialised by accident.
 *
 * ## Current definition, not a version
 *
 * §17 does not ask for a version parameter and §20's version-awareness is
 * about Technical Notes. Adding `?version=` later is additive; `resolveSnapshot`
 * is the seam, exactly as it is for the documentation routes.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import { blueprintFilename, buildBlueprint, readBlueprint } from '@instantmockapi/ips';
import { loadOwnedProject } from '../access.js';
import { definitionOf } from '../project-definition.js';
import { assertProjectQuota, createProjectRecord } from '../project-create.js';
import { toProjectDetail } from '../serializers.js';

export interface BlueprintRouteOptions {
  config: EnvConfig;
}

export const blueprintRoutes: FastifyPluginAsync<BlueprintRouteOptions> = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/projects/:id/blueprint', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

    /*
     * `exportedAt` is deliberately not stamped.
     *
     * `buildBlueprint` accepts one and this route declines to supply it, so two
     * exports of an unchanged project are identical bytes. That is what lets a
     * user diff two blueprints and see only what they changed, and it keeps the
     * round-trip guarantee (§25) checkable by comparison. When the file was
     * saved is answered by the file's own date.
     */
    const blueprint = buildBlueprint(definitionOf(project), {
      name: project.name,
      description: project.description ?? null,
    });

    /*
     * Content-Disposition, so a browser hitting this URL directly saves rather
     * than renders. The web app does its own download from the parsed body — it
     * pretty-prints for a human reader — but the URL is also just a URL, and
     * `curl -OJ` or a pasted link should produce the same file.
     */
    void reply.header(
      'content-disposition',
      `attachment; filename="${blueprintFilename({ slug: project.slug ?? null })}"`,
    );
    return blueprint;
  });

  /**
   * Import a blueprint as a **new** project (§14, §15, §24).
   *
   * ## The path
   *
   * §24 writes this as `POST /projects/:id/blueprint/import`, and that path is
   * wrong for what §15 requires: an import creates a new project and must never
   * overwrite an existing one, so there is no `:id` to address. §24 also says
   * to adjust naming to existing conventions, and the convention for creating a
   * project is `POST /projects`. Hence `POST /projects/import` — a static
   * segment, which Fastify's radix router prefers over a parameter, so it
   * cannot be shadowed by a future `POST /projects/:id`.
   *
   * ## Transactional (§14)
   *
   * Nothing is written until the blueprint has been read, migrated, validated
   * and normalised — `readBlueprint` runs inside `createProjectRecord`'s
   * `buildIps` callback, which fires before the first `save()`. So a rejected
   * blueprint creates no project, no entities, no relationships and no job. The
   * whole definition lives in one document's `ips` field, so there is no
   * multi-document write for a transaction to wrap.
   *
   * No generation job is enqueued here either. That is a separate call, which
   * keeps a failed import from leaving a job queued against nothing — and lets
   * the client show what it is about to create before spending the work.
   *
   * ## What the new project does not inherit
   *
   * A new `_id`, its own `publicId`, its own `slug` (suffixed if the source's is
   * still held in this account), no artifacts, no versions beyond v1, no hosted
   * URL, and **no auth secret**: `MockAuthSecret` is keyed by project id and
   * minted lazily, so the imported project's first token request creates a key
   * that has never existed anywhere else. §15 and §26's isolation requirement
   * are satisfied by there being nothing to copy.
   */
  app.post(
    '/projects/import',
    {
      schema: {
        body: {
          type: 'object',
          required: ['blueprint'],
          additionalProperties: false,
          properties: {
            /*
             * Unconstrained here on purpose. `readBlueprint` is the validator,
             * and it reports §14's path-and-reason detail for every problem; an
             * ajv schema over the same shape would produce a second, coarser
             * error vocabulary for the same file — which is what §14 means by
             * "do not create a second error system".
             */
            blueprint: {},
            /** Overrides the blueprint's own name, for "Shop (copy)". */
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const authUser = request.authUser;
      const body = request.body as {
        blueprint: unknown;
        name?: string;
        description?: string;
      };

      /*
       * The plan gate first, before the file is even read.
       *
       * A user at their project limit should be told that, not handed a
       * validation error about a blueprint that was fine.
       */
      await assertProjectQuota(authUser?.sub, authUser?.plan);

      const project = await createProjectRecord({
        ownerId: authUser?.sub,
        /*
         * One pass, which is the whole of §14's guarantee.
         *
         * `readBlueprint` runs the §13 pipeline — version gate, migrate,
         * validate the envelope, normalize, validate the canonical rules — and
         * throws its structured error if any step refuses. It runs here, inside
         * `prepare`, so it happens strictly before the first write: a rejected
         * blueprint creates no project, no entities, no relationships.
         *
         * `name` and `kind` are read out of the *validated* blueprint rather
         * than out of the raw body, which is why this is one callback and not a
         * set of fields plus a definition builder. Reading them before
         * validation would have meant validating twice, and would have left the
         * ordering here unexercised by any test.
         */
        prepare: (projectId) => {
          const result = readBlueprint(body.blueprint, { projectId });
          if (!result.ok) {
            throw result.error;
          }
          const { blueprint, ips } = result.value;

          return {
            name: body.name ?? blueprint.project.name,
            kind: blueprint.project.kind,
            // Derived, never taken from the blueprint: §12 excludes addressing,
            // and `slug` is uniquely indexed per owner. `ensurePublicIdentity`
            // suffixes it when the source project still holds the name.
            slug: null,
            description: body.description ?? blueprint.project.description ?? null,
            /*
             * Stored as a builder payload, which is the same shape: the
             * builder's `raw` is `{entities, generationConfig, authentication}`,
             * exactly the definition half of a blueprint. So
             * `POST /projects/:id/parse` keeps working on an imported project
             * without a new input-source type and without teaching
             * `parseInputSource` a fourth format.
             */
            inputSource: {
              type: 'builder' as const,
              raw: JSON.stringify({
                entities: blueprint.entities,
                generationConfig: blueprint.generationConfig,
                ...(blueprint.authentication === undefined
                  ? {}
                  : { authentication: blueprint.authentication }),
              }),
            },
            ips,
          };
        },
      });

      return reply.status(201).send(toProjectDetail(project));
    },
  );

  /**
   * Duplicate a project through the blueprint pathway (§19, §24).
   *
   * ## Why it goes through a blueprint rather than copying the document
   *
   * §19 requires it. Two of the things it buys are real and are tested; a third
   * that looks like the obvious answer is not, and saying so is worth more than
   * the plausible version.
   *
   * **It re-validates.** `readBlueprint` runs the canonical rules and the
   * duplicate-id check over the stored definition. A project whose `ips` has
   * drifted — written before a validator gained a check, or edited by a
   * migration — therefore fails to duplicate, with the field named, instead of
   * silently producing a copy nobody can edit.
   *
   * **It strips what a shared file would not carry.** `buildBlueprint` omits
   * credential-named keys from the envelope, and a stored auth block can
   * genuinely hold one: `parseBuilderPayload` passes the wizard's
   * `authentication` through and `validateAuth` ignores keys it does not know.
   * A direct copy would propagate that junk into the new project forever.
   *
   * **It does not save the duplicate from inheriting the original's
   * addressing** — that was the first justification written here and it was
   * wrong. `createProjectRecord` overwrites `publicId` and `slug` inside the
   * definition after minting the copy's own, so a direct `project.ips` copy
   * would have been corrected anyway. A mutation replacing this whole pathway
   * with a direct copy passed every test in `duplicate.test.ts` until the two
   * claims above were the ones being asserted.
   *
   * ## What is not copied, and why nothing has to do that
   *
   * Users, sessions, auth secrets, mock records, jobs, artifacts and versions
   * all live in their own collections keyed by project id. The duplicate has a
   * new id, so none of them resolve to it — there is no delete step and no list
   * of collections to keep in sync as the platform grows. §19's "generate new
   * runtime secrets" costs nothing for the same reason: `MockAuthSecret` is
   * minted lazily, so the copy's first token request creates a key that has
   * never existed anywhere.
   *
   * The one thing that *is* carried, deliberately, is the definition's stable
   * ids. The diff engine pairs entities and fields by id, so a duplicate whose
   * ids were re-minted could not be compared against its original in any useful
   * way.
   */
  app.post(
    '/projects/:id/duplicate',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const authUser = request.authUser;
      const body = (request.body ?? {}) as { name?: string; description?: string };

      const source = await loadOwnedProject(id, authUser?.sub ?? '');
      await assertProjectQuota(authUser?.sub, authUser?.plan);

      const project = await createProjectRecord({
        ownerId: authUser?.sub,
        prepare: (projectId) => {
          /*
           * The same two functions an import runs, on a blueprint that never
           * becomes a file. Building one in memory is the point of §19's
           * pathway: duplicate and import cannot diverge, because they are the
           * same two steps over the same format.
           */
          const blueprint = buildBlueprint(definitionOf(source), {
            name: body.name ?? `${source.name} (copy)`,
            description: body.description ?? source.description ?? null,
          });
          const result = readBlueprint(blueprint, { projectId });
          if (!result.ok) {
            /*
             * Reachable, and worth its own answer.
             *
             * A stored definition can be older than today's rules — a
             * historical document, or one written before a validator gained a
             * check. The blueprint round trip re-validates it, so duplicating
             * such a project fails here rather than producing a copy that
             * cannot be edited. The structured detail says which field, which
             * is what the owner needs to fix the original.
             */
            throw result.error;
          }

          return {
            name: result.value.blueprint.project.name,
            kind: result.value.blueprint.project.kind,
            // Derived, so the copy never contests the original's base path.
            slug: null,
            description: result.value.blueprint.project.description ?? null,
            inputSource: {
              type: 'builder' as const,
              raw: JSON.stringify({
                entities: result.value.blueprint.entities,
                generationConfig: result.value.blueprint.generationConfig,
                ...(result.value.blueprint.authentication === undefined
                  ? {}
                  : { authentication: result.value.blueprint.authentication }),
              }),
            },
            ips: result.value.ips,
          };
        },
      });

      return reply.status(201).send(toProjectDetail(project));
    },
  );
};
