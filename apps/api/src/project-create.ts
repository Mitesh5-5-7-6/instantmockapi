/**
 * Bringing a project into being (Phase 4 §14, §15, §19).
 *
 * Extracted from `POST /projects` because two more callers need exactly the
 * same sequence: blueprint import (§15) and Duplicate Project (§19). All three
 * differ only in *where the definition comes from* — a parsed input source, an
 * imported blueprint, or an existing project — and agree on everything after
 * that: the plan gate, stable ids from birth, addressing minted immediately,
 * and the shape of the stored document.
 *
 * Restating that sequence per caller is how an imported project ends up subtly
 * different from a created one — no `ent_` ids, or no `publicId` until the
 * first generation — and the difference would surface much later, as a diff
 * that reports every entity as new.
 *
 * ## Why this is transactional enough without a Mongo transaction
 *
 * §14 requires that a failed import creates nothing: no partial entities, no
 * partial relationships, no jobs. Everything a project's definition contains
 * lives inside the single `ips` field of a single document, so one `save()` is
 * atomic by MongoDB's own single-document guarantee — there is no multi-document
 * write to wrap.
 *
 * The ordering is what makes it hold: the definition is built and fully
 * validated *before* the first write, using the id of an in-memory document.
 * A rejected blueprint therefore fails with nothing saved, because nothing had
 * been saved yet. No generation job is created here either — that is a separate
 * call the caller makes afterwards, so a validation failure cannot leave a job
 * queued against a project that does not exist.
 */

import { getPlanConfig } from '@instantmockapi/config';
import {
  AppError,
  type InputSourceType,
  type PlanTier,
  type ProjectKind,
} from '@instantmockapi/shared';
import { Project, ensurePublicIdentity, type IProject } from '@instantmockapi/db';
import { ensureSchemaIds, type InternalProjectSchema } from '@instantmockapi/ips';

/**
 * Refuse before creating anything, when the plan is already full.
 *
 * `0` means unlimited, which is the enterprise plan's encoding and the reason
 * this is a `> 0` test rather than a truthiness one.
 */
export async function assertProjectQuota(
  ownerId: string | undefined,
  plan: PlanTier | undefined,
): Promise<void> {
  const planConfig = getPlanConfig(plan ?? 'free');
  if (planConfig.maxProjects <= 0) {
    return;
  }
  const count = await Project.countDocuments({ ownerId });
  if (count >= planConfig.maxProjects) {
    throw new AppError({
      code: 'PLAN_LIMIT_EXCEEDED',
      message: `Your ${plan ?? 'free'} plan allows at most ${planConfig.maxProjects} projects`,
    });
  }
}

/** Everything about a new project, computed and validated before any write. */
export interface PreparedProject {
  name: string;
  kind: ProjectKind;
  slug?: string | null;
  description?: string | null;
  inputSource: { type: InputSourceType; raw: string };
  ips: InternalProjectSchema;
}

export interface NewProjectInput {
  ownerId: string | undefined;
  /**
   * Produce the whole project, given the id it will have.
   *
   * A single callback rather than a set of fields plus a `buildIps` — and that
   * shape was the second attempt. The first took `name` and `kind` alongside a
   * definition builder, which forced the blueprint importer to validate *twice*:
   * once up front to learn the name and kind it had to pass in, then again
   * inside the builder with the real project id. Two passes meant the
   * "nothing is written until it validates" guarantee actually lived in the
   * caller's first pass, so the ordering here was never exercised by a test —
   * a mutation that moved the write earlier changed nothing observable.
   *
   * One callback fixes both: every field, including `name` and `kind`, comes
   * out of one validated pass, and throwing from it leaves nothing saved
   * because nothing has been saved yet.
   */
  prepare: (projectId: string) => PreparedProject;
}

/**
 * Create a project from a definition, exactly as `POST /projects` does.
 *
 * The order below is load-bearing at three points, each recorded where it
 * matters:
 *
 * - `kind` is set on the document before `ensurePublicIdentity`, because it
 *   selects the public-id prefix (`prj_`/`sng_`/`aut_`).
 * - `buildIps` runs before the first `save()`, so a rejected definition creates
 *   nothing.
 * - `ensureSchemaIds` runs on the stored definition, so a project is diffable
 *   from birth. Without it the very first entity rename is undetectable: with
 *   no id on either side, "renamed Product to Item" and "deleted Product, added
 *   Item" are the same document.
 */
export async function createProjectRecord(input: NewProjectInput): Promise<IProject> {
  /*
   * An empty document, purely to mint an `_id`.
   *
   * Mongoose assigns `_id` on instantiation and validates only on `save`, so
   * this touches nothing. The id is needed first because it is stamped inside
   * the definition — and `prepare` is what needs it.
   */
  const project = new Project();
  const projectId = String(project._id);

  // Throws on an invalid definition, with nothing written.
  const prepared = input.prepare(projectId);

  project.set({
    ownerId: input.ownerId,
    name: prepared.name,
    kind: prepared.kind,
    slug: prepared.slug ?? null,
    description: prepared.description ?? null,
    status: 'draft',
    inputSource: prepared.inputSource,
  });
  project.ips = { ...prepared.ips, projectId, version: 1 };
  ensureSchemaIds(project.ips);
  project.generationConfig = prepared.ips.generationConfig;
  project.currentVersion = 1;
  await project.save();

  /*
   * Addressable from creation, so a wizard can show the hosted URL before the
   * first generation runs — and so an importer can hand back a URL immediately.
   *
   * A second write rather than one, which is how `POST /projects` has always
   * worked: `ensurePublicIdentity` saves internally, retrying on a public-id
   * collision and suffixing a slug that is already taken in this account. That
   * last part is what makes importing a blueprint back into the account it came
   * from work at all — the original's slug is still held, so the copy becomes
   * `shop-2`.
   *
   * If this second write fails the project exists without addressing, which is
   * a state the platform already tolerates and heals: `ensurePublicIdentity` is
   * called lazily on read.
   */
  await ensurePublicIdentity(project);
  project.ips = {
    ...project.ips,
    kind: project.kind ?? 'project',
    ...(project.publicId ? { publicId: project.publicId } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
  };
  await project.save();

  return project;
}
