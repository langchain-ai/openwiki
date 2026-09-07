/**
 * Stable identity and authored navigation metadata for one Markdown section.
 */
export interface PageSection {
  /**
   * OpenWiki-generated identifier preserved across heading and scope changes.
   */
  id: string;

  /**
   * Wiki-relative page followed by encoded heading ancestors separated by `#`.
   */
  location: string;

  /**
   * Authored explanation of the section's scope for a future reader.
   */
  description: string;
}

/**
 * Explicit connection between a passage and the claims it expresses.
 */
export interface ProseBinding {
  /**
   * OpenWiki-generated identifier preserved across passage edits.
   */
  id: string;

  /**
   * Identifier of the owning section in the same page sidecar.
   */
  sectionId: string;

  /**
   * Exact Markdown passage within the section's direct body, normalized to LF.
   */
  text: string;

  /**
   * Identifiers of the page's claims expressed by this passage.
   */
  claimIds: string[];
}

/**
 * Complete section and binding state maintained alongside a page's claims.
 */
export interface PageProse {
  /**
   * Stable sections with authored descriptions.
   */
  sections: PageSection[];

  /**
   * Explicit passage-to-claim connections.
   */
  bindings: ProseBinding[];
}

/**
 * New section or complete replacement for an existing section's metadata.
 */
export interface ProposedPageSection extends Omit<PageSection, "id"> {
  /**
   * Existing section identifier; omit it to allocate a new identity.
   */
  id?: string;
}

/**
 * New binding or complete replacement for an existing passage connection.
 */
export interface ProposedProseBinding {
  /**
   * Existing binding identifier; omit it to allocate a new identity.
   */
  id?: string;

  /**
   * Existing section ID or exact location of a section added in this submission.
   */
  section: string;

  /**
   * Exact passage as written in the finished Markdown page.
   */
  text: string;

  /**
   * Existing claim IDs or exact statements of claims added in this submission.
   */
  claims: string[];
}

/**
 * Sparse changes to a page's section metadata and prose bindings.
 */
export interface ProposedPageProse {
  /**
   * New sections and revisions carrying their existing IDs.
   */
  sections?: ProposedPageSection[];

  /**
   * Sections explicitly removed from the page.
   */
  removedSectionIds?: string[];

  /**
   * New bindings and revisions carrying their existing IDs.
   */
  bindings?: ProposedProseBinding[];

  /**
   * Bindings explicitly removed from the page.
   */
  removedBindingIds?: string[];
}
