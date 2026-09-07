import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ClaimSessionError } from "../../core/errors.js";
import type { Claim } from "../../core/types.js";
import type { PageProse, ProposedPageProse } from "./prose-types.js";
import { parseMarkdownSections } from "./sections.js";

/**
 * Copies prose metadata across session and persistence ownership boundaries.
 *
 * @param prose - Complete metadata to detach from its owner.
 * @returns An independent copy, including each binding's claim references.
 */
export function clonePageProse(prose: PageProse): PageProse {
  return {
    sections: prose.sections.map((section) => ({ ...section })),
    bindings: prose.bindings.map((binding) => ({
      ...binding,
      claimIds: [...binding.claimIds],
    })),
  };
}

/**
 * Rejects incomplete or dangling sidecar relationships without reading Markdown.
 *
 * @param prose - Complete section and binding state.
 * @param claims - Resulting claims owned by the page.
 */
export function assertProseReferences(
  prose: PageProse,
  claims: readonly Claim[],
): void {
  const issues: string[] = [];
  const sectionIds = new Set<string>();
  const locations = new Set<string>();
  for (const section of prose.sections) {
    if (sectionIds.has(section.id))
      issues.push(`Duplicate section ID ${section.id}.`);
    if (locations.has(section.location))
      issues.push(`Duplicate section location ${section.location}.`);
    sectionIds.add(section.id);
    locations.add(section.location);
  }
  const claimIds = new Set(claims.map(({ id }) => id));
  const bindingIds = new Set<string>();
  const boundClaims = new Set<string>();
  for (const binding of prose.bindings) {
    if (bindingIds.has(binding.id))
      issues.push(`Duplicate binding ID ${binding.id}.`);
    bindingIds.add(binding.id);
    if (!sectionIds.has(binding.sectionId)) {
      issues.push(
        `${binding.id}: unknown section ${binding.sectionId}; update its section reference or remove the binding.`,
      );
    }
    if (new Set(binding.claimIds).size !== binding.claimIds.length) {
      issues.push(`${binding.id}: repeated claim references.`);
    }
    for (const id of binding.claimIds) {
      if (!claimIds.has(id))
        issues.push(
          `${binding.id}: unknown or retracted claim ${id}; update or remove the binding.`,
        );
      boundClaims.add(id);
    }
  }
  for (const id of claimIds) {
    if (!boundClaims.has(id))
      issues.push(
        `${id}: no prose binding; bind its passage or retract a claim no longer expressed by the page.`,
      );
  }
  throwProseIssues(issues);
}

/**
 * Validates all resulting metadata against the finished page, including records
 * omitted from a sparse submission. Structural checks do not prove meaning.
 *
 * @param page - Canonical generated-page path used to resolve section locations.
 * @param markdown - Finished Markdown page.
 * @param prose - Complete metadata after sparse reconciliation.
 * @param claims - Complete resulting claims.
 */
export function assertPageProse(
  page: string,
  markdown: string,
  prose: PageProse,
  claims: readonly Claim[],
): void {
  const issues: string[] = [];
  try {
    assertProseReferences(prose, claims);
  } catch (error) {
    if (!(error instanceof ClaimSessionError)) throw error;
    issues.push(error.message);
  }
  const parsed = parseMarkdownSections(page, markdown);
  const sections = new Map(
    prose.sections.map((section) => [section.id, section]),
  );
  const describedLocations = new Set(
    prose.sections.map(({ location }) => location),
  );
  for (const section of parsed) {
    if (!describedLocations.has(section.location)) {
      issues.push(
        `${section.location}: missing section description; add section metadata.`,
      );
    }
  }
  for (const section of prose.sections) {
    const matches = parsed.filter(
      ({ location }) => location === section.location,
    );
    if (matches.length !== 1) {
      issues.push(
        `${section.id}: section location ${section.location} is ${matches.length ? "ambiguous" : "missing"}; correct the heading/location or remove the section.`,
      );
    }
  }
  for (const binding of prose.bindings) {
    const section = sections.get(binding.sectionId);
    if (!section) continue;
    const matches = parsed.filter(
      ({ location }) => location === section.location,
    );
    if (matches.length !== 1) continue;
    const body = matches[0].body;
    const first = body.indexOf(binding.text);
    if (
      !binding.text.trim() ||
      first < 0 ||
      body.indexOf(binding.text, first + 1) >= 0
    ) {
      issues.push(
        `${binding.id}: passage is ${first < 0 ? "missing" : "empty or ambiguous"} in ${section.location}; correct its text or section reference, or remove the binding if the passage was deleted.`,
      );
    }
  }
  throwProseIssues(issues);
}

/**
 * Applies sparse section and binding decisions to detached state, then validates
 * the whole result. Nothing is installed in the session until this succeeds.
 *
 * @param page - Generated page owning the metadata.
 * @param markdown - Finished Markdown to validate.
 * @param previous - Existing metadata, absent for an unlinked legacy page.
 * @param claims - Resulting claims, including newly allocated IDs.
 * @param proposed - Sparse additions, revisions, and removals.
 * @returns Complete validated section and binding state.
 */
export function reconcilePageProse(
  page: string,
  markdown: string,
  previous: PageProse | undefined,
  claims: readonly Claim[],
  proposed: ProposedPageProse,
): PageProse {
  const sections = reconcileRecords(
    "section",
    previous?.sections ?? [],
    (proposed.sections ?? []).map((section) => ({
      ...section,
      location: section.location.trim(),
      description: section.description.trim(),
    })),
    proposed.removedSectionIds ?? [],
  );
  for (const section of sections) {
    if (!section.description)
      throw new ClaimSessionError(
        `${section.id}: section description is empty.`,
      );
  }
  const bindings = reconcileRecords(
    "binding",
    previous?.bindings ?? [],
    (proposed.bindings ?? []).map((binding) => ({
      ...(binding.id ? { id: binding.id } : {}),
      sectionId: resolveReference(
        "section",
        binding.section,
        sections,
        (section) => section.location,
      ),
      text: binding.text.replace(/\r\n?/gu, "\n"),
      claimIds: binding.claims
        .map((reference) =>
          resolveReference(
            "claim",
            reference,
            claims,
            (claim) => claim.statement,
          ),
        )
        .sort(),
    })),
    proposed.removedBindingIds ?? [],
  );
  const result = { sections, bindings };
  assertPageProse(page, markdown, result, claims);
  return result;
}

/**
 * Resolves an existing ID or an exact natural reference for a newly added record.
 *
 * @param kind - Record kind included in author-facing errors.
 * @param reference - Existing ID, section location, or exact new claim statement.
 * @param records - Complete resulting records from this submission.
 * @param identify - Extracts the natural reference used before an ID is known.
 * @returns The uniquely resolved stable identifier.
 */
function resolveReference<T extends { id: string }>(
  kind: string,
  reference: string,
  records: readonly T[],
  identify: (record: T) => string,
): string {
  const value = reference.trim();
  const matches = records.filter(
    (record) => record.id === value || identify(record) === value,
  );
  if (matches.length !== 1) {
    throw new ClaimSessionError(
      `Binding ${kind} reference ${JSON.stringify(value)} is ${matches.length ? "ambiguous" : "unknown"}; use an existing ID or an exact new ${kind === "claim" ? "statement" : "location"}.`,
    );
  }
  return matches[0].id;
}

/**
 * Reconciles identified records without requiring unchanged records to be echoed.
 * Exact repeated additions and already-completed removals are safe to retry.
 *
 * @param kind - Identifier prefix and diagnostic record kind.
 * @param previous - Complete existing records.
 * @param proposed - New records without IDs and revisions with existing IDs.
 * @param removedIds - Explicit removals.
 * @returns Detached resulting records in stable insertion order.
 */
function reconcileRecords<T extends { id: string }>(
  kind: string,
  previous: readonly T[],
  proposed: readonly (Omit<T, "id"> & { id?: string })[],
  removedIds: readonly string[],
): T[] {
  const result = new Map(
    previous.map((record) => [record.id, structuredClone(record)]),
  );
  const targeted = new Set<string>();
  for (const id of removedIds) {
    if (targeted.has(id))
      throw new ClaimSessionError(`${kind} ${id} has multiple decisions.`);
    targeted.add(id);
    result.delete(id);
  }
  for (const record of proposed) {
    const { id, ...fields } = record;
    if (id && (!result.has(id) || targeted.has(id))) {
      throw new ClaimSessionError(
        `${kind} ${id} is unknown or has multiple decisions; inspect the current page metadata and retry.`,
      );
    }
    const matching = [...result.values()].find((candidate) => {
      const content = { ...candidate } as Partial<T>;
      delete content.id;
      return isDeepStrictEqual(content, fields);
    });
    const resolvedId =
      id ?? matching?.id ?? `${kind}_${randomUUID().replaceAll("-", "")}`;
    if (targeted.has(resolvedId))
      throw new ClaimSessionError(
        `${kind} ${resolvedId} has multiple decisions.`,
      );
    targeted.add(resolvedId);
    result.set(resolvedId, { id: resolvedId, ...fields } as T);
  }
  return [...result.values()];
}

/**
 * Reports all structural issues together so the author can correct one page.
 *
 * @param issues - Actionable validation messages collected for this submission.
 */
function throwProseIssues(issues: readonly string[]): void {
  if (issues.length) throw new ClaimSessionError(issues.join("\n"));
}
