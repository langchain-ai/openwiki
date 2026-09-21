import { describe, expect, test } from "vitest";
import {
  ListWikisInput,
  ListWorkspacesInput,
  ReadInput,
  SearchInput,
  createRetrievalTools,
} from "../../src/integrations/core/retrieval-tools.ts";

describe("repository retrieval tool contracts", () => {
  test("search accepts an optional explicit workspace", () => {
    expect(
      SearchInput.parse({ root: "/repo", query: "request routing" }),
    ).toEqual({ root: "/repo", query: "request routing" });
    expect(
      SearchInput.safeParse({
        root: "/repo",
        query: "request routing",
        workspace: "payments",
      }).success,
    ).toBe(true);
  });

  test("listing schemas traverse current wiki memberships and workspace members", () => {
    expect(ListWorkspacesInput.parse({ root: "/repo" })).toEqual({
      root: "/repo",
    });
    expect(
      ListWorkspacesInput.parse({ root: "/repo", wiki: "shared-infra" }),
    ).toEqual({ root: "/repo", wiki: "shared-infra" });
    expect(
      ListWikisInput.parse({ root: "/repo", workspace: "payments" }),
    ).toEqual({ root: "/repo", workspace: "payments" });
  });

  test("read accepts one bounded wiki ID returned by linked search", () => {
    expect(
      ReadInput.parse({
        root: "/repo",
        wiki: "control-plane",
        page: "openwiki/architecture/routing.md",
        sections: ["publication"],
      }),
    ).toEqual({
      root: "/repo",
      wiki: "control-plane",
      page: "openwiki/architecture/routing.md",
      sections: ["publication"],
    });
  });

  test("tool descriptions explain workspace discovery and read routing", () => {
    const tools = new Map(
      createRetrievalTools().map((tool) => [tool.name, tool]),
    );

    expect(tools.get("openwiki_list_workspaces")?.description).toContain(
      "current repository",
    );
    expect(tools.get("openwiki_list_wikis")?.description).toContain(
      "every repository wiki",
    );
    expect(tools.get("openwiki_search")?.description).toContain(
      "status=workspace_required",
    );
    expect(tools.get("openwiki_search")?.description).toContain(
      "Do not call at task start or preload linked wikis",
    );
    expect(tools.get("openwiki_search")?.description).toContain(
      "stop once grounded",
    );
    expect(tools.get("openwiki_read")?.description).toContain(
      "result's wiki ID",
    );
  });
});
