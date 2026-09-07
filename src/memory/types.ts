import type {
  PageSection,
  ProseBinding,
} from "../claims/brains/code/prose-types.js";
import type { Claim, Evidence } from "../claims/core/types.js";
import type { UnclassifiedReflections } from "./reflection-types.js";

/**
 * A completed comparison or an explicit explanation that it could not be checked.
 */
export type MemoryLayer<T> =
  | {
      /**
       * Detected changes in this scope; an empty array means the comparison succeeded.
       */
      changes: T[];
    }
  | {
      /**
       * Why the comparison is unavailable, without implying that no changes exist.
       */
      unavailable: string;
    };

/**
 * Main changes annotated with incorporation into checkout history.
 */
export type ShortTermChange<T> = T & {
  /**
   * Whether all contributing main history is incorporated into the checkout.
   * Local work can subsequently change the same resource again.
   */
  inCheckout: boolean;
};

/**
 * Change layers shared by all three repository memory tools.
 */
export interface MemoryChanges<T> {
  /**
   * Main changes since the relevant wiki source checkpoint.
   */
  shortTerm: MemoryLayer<ShortTermChange<T>>;

  /**
   * Net branch and working-tree changes from their shared history with main.
   */
  working: MemoryLayer<T>;
}

/**
 * Independently available source comparisons and pending findings for one tool scope.
 */
export interface MemoryContext<TChange, TReflection> {
  /**
   * Main changes and locally available reflections already shared through main.
   */
  shortTerm: MemoryLayer<ShortTermChange<TChange>> & {
    /**
     * Pending merged findings, even when the source comparison is unavailable.
     */
    reflections: TReflection[];
  };

  /**
   * Net local source changes and findings specific to the current work.
   */
  working: MemoryLayer<TChange> & {
    /**
     * Pending branch or local findings, each once within the response.
     */
    reflections: TReflection[];
  };

  /**
   * Readable findings whose origin is unknown, or gaps in the pending-file inventory.
   */
  unclassifiedReflections?: UnclassifiedReflections<TReflection>;
}

/**
 * Consolidated wiki knowledge accompanied by source changes and pending discoveries.
 */
export interface WikiMemory<
  TKnowledge,
  TChange,
  TReflection,
> extends MemoryContext<TChange, TReflection> {
  /**
   * Maintained wiki knowledge, preserved as authored.
   */
  longTerm: TKnowledge;
}

/**
 * A changed repository resource connected to wiki pages for navigation.
 */
export interface WikiPageChange {
  /**
   * Canonical repository URI for the changed file.
   */
  resource: string;

  /**
   * Wiki-relative pages whose claim evidence references the file.
   * An empty list means no known affected page, not proof of irrelevance.
   */
  affectedPages: string[];
}

/**
 * A changed repository resource connected to a page's described sections.
 */
export interface WikiSectionChange {
  /**
   * Canonical repository URI for the changed file.
   */
  resource: string;

  /**
   * Stable section IDs connected through claims and prose bindings.
   */
  affectedSectionIds: string[];
}

/**
 * Changed source resources connected to claims expressed in selected prose.
 */
export interface WikiClaimChange {
  /**
   * Canonical repository URI for the changed file.
   */
  resource: string;

  /**
   * Relevant claim IDs whose source evidence needs review.
   */
  affectedClaimIds: string[];
}

/**
 * Authored page metadata that helps an agent choose where to look.
 */
export interface WikiPageSummary {
  /**
   * Markdown path relative to the wiki directory, accepted by outline and read.
   */
  page: string;

  /**
   * Page subject, taken directly from OKF frontmatter.
   */
  title: string;

  /**
   * Authored scope and questions answered by the page.
   */
  description: string;
}

/**
 * Fixed repository introduction and directory of factual wiki pages.
 */
export interface WikiOrientation {
  /**
   * Opening quickstart prose describing the repository and its major parts.
   */
  overview: string;

  /**
   * Complete page directory in stable path order, excluding structural files.
   */
  pages: WikiPageSummary[];
}

/**
 * Page navigation combining Markdown structure with maintained section metadata.
 */
export interface WikiOutline extends WikiPageSummary {
  /**
   * Flat sections in document order; locations express heading ancestry.
   */
  sections: Array<
    PageSection & {
      /**
       * Markdown heading text, or an empty string for an unheaded introduction.
       */
      title: string;
    }
  >;
}

/**
 * Selected wiki prose and the claims and evidence connected to its passages.
 */
export interface WikiRead {
  /**
   * Markdown path relative to the wiki directory.
   */
  page: string;

  /**
   * Selected sections and descendants, each returned once in document order.
   */
  sections: Array<
    Pick<PageSection, "id" | "location"> & {
      /**
       * Original heading and direct Markdown body, with LF line endings.
       */
      content: string;
    }
  >;

  /**
   * Passage-to-claim connections belonging to the returned sections.
   */
  bindings: ProseBinding[];

  /**
   * Referenced claims, each once, without internal evidence version tokens.
   */
  claims: Array<
    Omit<Claim, "evidence"> & {
      /**
       * Repository resources supporting the claim for further investigation.
       */
      evidence: Array<Pick<Evidence, "resource">>;
    }
  >;
}
