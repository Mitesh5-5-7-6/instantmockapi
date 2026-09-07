/**
 * Version routes: history listing, snapshot restore, and publishing.
 *
 * **A `/versions/compare` route (Phase 2 §24) must be registered before any
 * `/versions/:version` route.** Fastify's radix router prefers a static segment
 * over a parameter so it would resolve correctly, but a `:version` route
 * declared with `type: 'integer'` turns a typo in the static path into a
 * confusing 400 rather than a 404.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { EnvConfig } from '@instantmockapi/config';
import {
  Job,
  Project,
  User,
  Version,
  publishFields,
  publishedVersionOf,
  versionArtifactOutcomes,
} from '@instantmockapi/db';
import { AppError, evaluatePromotion } from '@instantmockapi/shared';
import {
  compareSnapshots,
  groupChanges,
  summariseChangeTypes,
  summariseImpact,
} from '@instantmockapi/ips';
import { loadOwnedProject, notFound } from '../access.js';
import {
  analyseDraft,
  seedDraftFromSnapshot,
  toDraftAnalysisResponse,
  toDraftResponse,
} from '../draft-service.js';
import { listEnvelope, parsePagination } from '../pagination.js';
import { toChangeTreeView, toImpactView, toMatchingView } from '../change-serializers.js';
import { toVersionView } from '../serializers.js';
import { backfillInitialVersion, resolveSnapshot, versionStatuses } from '../version-service.js';

export interface VersionRouteOptions {
  config: EnvConfig;
}

export const versionRoutes: FastifyPluginAsync<VersionRouteOptions> = async (app, { config }) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/projects/:id/versions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; limit?: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');
      const pageParams = parsePagination(query, config.maxPaginationLimit);

      // §42's backfill, lazily and on read — the `ensurePublicIdentity`
      // precedent rather than a startup migration, so it converges without a
      // deploy step and running it twice is a no-op. A project generated before
      // Phase 2 has a served version with no snapshot; without this its history
      // is empty and nothing about it is comparable.
      await backfillInitialVersion(project, publishedVersionOf(project));

      const [total, versions] = await Promise.all([
        Version.countDocuments({ projectId: project._id }),
        Version.find({ projectId: project._id })
          .sort({ version: -1 })
          .skip(pageParams.skip)
          .limit(pageParams.limit),
      ]);

      // Artifact rows for the versions on THIS page only, in one aggregation.
      // §28 wants the history page cheap, and the alternative — one query per
      // row inside a `.map()` — is the N+1 the project list already avoids.
      const statuses = await versionStatuses(
        project,
        versions.map((version) => version.version),
      );

      return reply.send(
        listEnvelope(
          versions.map((version) => toVersionView(version, statuses.get(version.version))),
          pageParams,
          total,
        ),
      );
    },
  );

  /**
   * Compare any two versions (Phase 2 §24, §36, §37).
   *
   * **Registered before `/versions/:version`.** Fastify prefers a static
   * segment over a parameter so the order is belt-and-braces, but a `:version`
   * route declared `type: 'integer'` would turn `/versions/compre` into a
   * confusing 400 rather than a 404.
   *
   * ## Version numbers, not ids
   *
   * §28's own example is `?from=v3&to=v4`, the pickers hold
   * `VersionView.version`, `Version` is uniquely keyed `{projectId, version}`,
   * and `restore`/`publish` already address by number. Accepting a bare integer
   * keeps one addressing scheme across the whole phase — the API should not be
   * parsing display formatting.
   *
   * ## What does NOT cross the wire
   *
   * No `ipsSnapshot`, no `configSnapshot`. §28's rule, and §15's side-by-side
   * panel does not need them: `change.before`/`after` already carry the
   * per-field values, and a field group collects that field's type, requiredness
   * and validation changes together — so the panel is a render of one group.
   * "Side-by-side needs both schemas" is the obvious wrong conclusion.
   */
  app.get(
    '/projects/:id/versions/compare',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { type: 'integer', minimum: 1 },
            to: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { from, to } = request.query as { from: number; to: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      await backfillInitialVersion(project, publishedVersionOf(project));

      const [left, right] = await Promise.all([
        resolveSnapshot(project, from),
        resolveSnapshot(project, to),
      ]);

      const { diff, impact } = compareSnapshots(left.snapshot, right.snapshot);
      const tree = groupChanges(diff.changes, impact);
      const view = toChangeTreeView(tree, config.maxDiffChanges);

      return reply.send({
        from: left.ref,
        to: right.ref,
        direction: diff.direction,
        summary: {
          total: tree.counts.total,
          changeTypes: summariseChangeTypes(diff.changes),
          impact: summariseImpact(diff.changes),
          risk: impact.risk,
          affectedEntities: tree.entities.length,
          affectedEndpoints: impact.affected.length,
          affectedArtifacts: impact.artifacts.length,
        },
        matching: toMatchingView(diff.matching),
        tree: view.tree,
        truncated: view.truncated,
        ...toImpactView(impact),
      });
    },
  );

  app.post(
    '/projects/:id/versions/:version/restore',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'version'],
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, version } = request.params as { id: string; version: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      // Backfill here too, not only on the history read. Restore needs a
      // `Version` row to copy from, so without this a project that predates
      // Phase 2 could not restore its own live version until somebody happened
      // to open the history page first — a 404 that depended on browsing order.
      await backfillInitialVersion(project, publishedVersionOf(project));

      const snapshot = await Version.findOne({ projectId: project._id, version });
      if (!snapshot) {
        throw notFound('Version');
      }

      /*
       * Restore SEEDS THE DRAFT. It does not write the live definition.
       *
       * This used to copy the snapshot straight onto `project.ips` and bump
       * `currentVersion` — so the one action most likely to remove fields and
       * break callers was the only one that skipped the review every ordinary
       * edit goes through. Now a rollback runs the same pipeline:
       *
       *     restore ─▶ draft ─▶ diff ─▶ impact ─▶ review ─▶ commit ─▶ generate ─▶ publish
       *
       * §22 asks for exactly that, and §16 requires a rollback not to touch
       * `publishedVersion` — which this cannot, because nothing here goes near
       * it. The live API keeps serving whatever it was serving, and the version
       * that eventually carries this definition is stamped `ROLLBACK` with its
       * source when the draft is committed.
       *
       * The response is the draft plus its impact, so the client can go straight
       * to the review screen instead of fetching twice.
       */
      const ctx = await seedDraftFromSnapshot(project, {
        version,
        ipsSnapshot: snapshot.ipsSnapshot,
        configSnapshot: snapshot.configSnapshot,
      });

      return reply.send({
        ...toDraftResponse(ctx),
        rollbackSourceVersion: version,
        analysis: toDraftAnalysisResponse(analyseDraft(ctx)),
      });
    },
  );

  /**
   * Publish a version (Phase 2 §1–§3).
   *
   * The **only** place `publishedVersion` advances from the API. Generation
   * stops at READY; this is the explicit action that moves the live pointer.
   *
   * ## What is checked, and why each answer is the one it is
   *
   * | condition | response |
   * | --- | --- |
   * | not this user's project | `NOT_FOUND` — existence is not leaked (§40) |
   * | no `Version` row | `NOT_FOUND` — the version was never authored |
   * | already the live version | **200 no-op**, with `expiresAt` untouched |
   * | older than the live version | `CONFLICT` — that is a rollback (§16) |
   * | a job is in flight for it | `CONFLICT` — §27: never publish a generating version |
   * | not runtime-ready | `VERSION_NOT_READY`, naming the blocking artifacts |
   *
   * The already-published case is a success rather than an error deliberately:
   * the UI hides Publish on the live version, so a request here is a stale tab
   * or a double-click, and a red toast for "it is already live" is worse than
   * nothing. It must not refresh `expiresAt` though, or Publish becomes a free
   * renewal button for a free-tier project.
   */
  app.post(
    '/projects/:id/versions/:version/publish',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'version'],
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, version } = request.params as { id: string; version: number };
      const project = await loadOwnedProject(id, request.authUser?.sub ?? '');

      // Same reason as on restore: a project that predates Phase 2 must be
      // publishable without someone having opened the history page first.
      await backfillInitialVersion(project, publishedVersionOf(project));

      const snapshot = await Version.exists({ projectId: project._id, version });
      if (!snapshot) {
        throw notFound('Version');
      }

      const live = project.publishedVersion ?? null;

      if (live === version) {
        return reply.send({
          published: false,
          reason: 'already-published',
          version,
          publishedVersion: live,
          hosted: project.hosted,
          degraded: [],
          staleDataRisk: false,
        });
      }

      if (live !== null && version < live) {
        throw new AppError({
          code: 'CONFLICT',
          message: `v${version} is older than the live v${live}. Restore it to create a new version rather than publishing backwards.`,
        });
      }

      // §27: a generating version must never go live. Not a complete fence —
      // `createGenerationJob` resets the artifact rows before it writes the job
      // document — but that window fails in the safe direction, because the
      // readiness check below then sees `pending` rows and refuses.
      const inFlight = await Job.exists({
        projectId: project._id,
        version,
        status: { $in: ['queued', 'running'] },
      });
      if (inFlight) {
        throw new AppError({
          code: 'CONFLICT',
          message: `v${version} is still generating. Wait for the job to settle before publishing.`,
        });
      }

      const outcomes = await versionArtifactOutcomes(project._id, version);
      // The same policy the worker uses, so "publishable" means one thing. It
      // still gates on runtime readiness rather than on every artifact — a
      // failed OpenAPI degrades a version, it does not block it.
      const decision = evaluatePromotion({ candidate: version, published: live, outcomes });
      if (!decision.promote) {
        throw new AppError({
          code: 'VERSION_NOT_READY',
          message: decision.reason,
          details: decision.readiness.blocking.map((artifactType) => ({
            path: `artifacts.${artifactType}`,
            issue: 'must be generated successfully before this version can be published',
          })),
        });
      }

      const owner = await User.findById(project.ownerId);
      // Compare-and-swap on the pointer: two tabs publishing different versions
      // must not interleave into a pointer neither of them validated against the
      // artifact rows.
      const updated = await Project.findOneAndUpdate(
        { _id: project._id, publishedVersion: live },
        {
          $set: publishFields(project, version, {
            baseUrl: config.hostedBaseUrl,
            plan: owner?.plan ?? 'free',
          }),
        },
        { new: true },
      );
      if (!updated) {
        throw new AppError({
          code: 'CONFLICT',
          message: 'This project was published by another request. Reload and try again.',
        });
      }

      // The publish event. Nothing else records it: "was live and is not any
      // more" leaves no trace in the artifact rows, so the history list and the
      // derived SUPERSEDED status both depend on this.
      await Version.updateOne(
        { projectId: project._id, version, publishedAt: null },
        { $set: { publishedAt: new Date() } },
      );

      return reply.send({
        published: true,
        version,
        publishedVersion: updated.publishedVersion ?? version,
        hosted: updated.hosted,
        // Free from the readiness result, and exactly the warnings worth
        // surfacing at the moment of the decision.
        degraded: decision.readiness.degraded,
        staleDataRisk: decision.readiness.staleDataRisk,
      });
    },
  );
};
