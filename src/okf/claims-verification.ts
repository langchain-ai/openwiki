import { isDeepStrictEqual } from "node:util";
import type { ClaimsVerificationEvent } from "../claims/brains/code/types.js";
import { parseFrontmatterFields, setOkfVerified } from "./frontmatter.js";

/**
 * Minimal generated-page storage required by the verification projector.
 */
export interface ClaimsVerificationPageStore {
  discoverPages(): Promise<string[]>;
  readMarkdown(page: string): Promise<string>;
  writeMarkdown(page: string, content: string): Promise<void>;
}

/**
 * Exact pre-projection Markdown keyed by every page changed by the projector.
 */
export type ClaimsVerificationChanges = ReadonlyMap<string, string>;

/**
 * Reconciles OpenWiki-owned OKF verification events against durable Claims
 * state while retaining human, process, and other producer events.
 *
 * Every grounded concept participates. A page without an active durable event
 * loses only events in the `openwiki/<version>` actor family. Bare verifier
 * mappings are normalized to the canonical list representation when touched.
 *
 * @param store - Contained generated-page storage.
 * @param verificationByPage - Active durable event per Claims page.
 * @returns Original Markdown for changed pages, used for transactional rollback.
 */
export async function synchronizeClaimsVerification(
  store: ClaimsVerificationPageStore,
  verificationByPage: ReadonlyMap<string, ClaimsVerificationEvent | null>,
): Promise<ClaimsVerificationChanges> {
  const changes = new Map<string, string>();

  for (const page of await store.discoverPages()) {
    const content = await store.readMarkdown(page);
    const current = readVerificationEvents(content);
    const retained = current.filter((event) => !isOpenWikiActor(event.by));
    const active = verificationByPage.get(page);
    const next = active ? [...retained, { ...active }] : retained;

    if (isDeepStrictEqual(current, next) && isCanonicalList(content)) continue;
    if (current.length === 0 && next.length === 0) continue;

    const projected = setOkfVerified(content, next);
    if (projected === content) continue;
    await store.writeMarkdown(page, projected);
    changes.set(page, content);
  }

  return changes;
}

/**
 * Restores exact Markdown for pages whose sidecar hash refresh failed.
 */
export async function rollbackClaimsVerification(
  store: ClaimsVerificationPageStore,
  originals: ClaimsVerificationChanges,
  pages: readonly string[],
): Promise<void> {
  for (const page of pages) {
    const original = originals.get(page);
    if (original !== undefined) {
      await store.writeMarkdown(page, original);
    }
  }
}

/**
 * Reads valid verification events, treating malformed producer input as empty.
 */
function readVerificationEvents(
  content: string,
): Array<Record<string, unknown> & { by: string }> {
  const value = parseFrontmatterFields(content)?.verified;
  const events = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return events.filter(
    (event): event is Record<string, unknown> & { by: string } =>
      isRecord(event) &&
      typeof event.by === "string" &&
      event.by.trim() !== "" &&
      (event.at === undefined ||
        (typeof event.at === "string" && event.at.trim() !== "")),
  );
}

/**
 * Reports whether an existing `verified` value already uses list form.
 */
function isCanonicalList(content: string): boolean {
  const fields = parseFrontmatterFields(content);
  return fields?.verified === undefined || Array.isArray(fields.verified);
}

/**
 * Identifies events owned by any released OpenWiki producer version.
 */
function isOpenWikiActor(actor: string): boolean {
  return /^openwiki\//u.test(actor);
}

/**
 * Narrows an unknown value to a non-array mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
