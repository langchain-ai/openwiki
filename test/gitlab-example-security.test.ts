import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const examplePath = new URL(
  "../examples/openwiki-update.gitlab-ci.yml",
  import.meta.url,
);

describe("GitLab CI example", () => {
  test("keeps Git credentials out of remote URLs and traced commands", async () => {
    const example = await readFile(examplePath, "utf8");
    const config = parse(example) as {
      openwiki_update?: { script?: unknown[] };
    };

    expect(config.openwiki_update?.script).toBeInstanceOf(Array);
    expect(example).not.toMatch(/https?:\/\/[^/\s]+@/u);
    expect(example).toContain("set +x");
    expect(example).toContain('credential.helper="$credential_helper"');
    expect(example).toContain("<<'EOF'");
    expect(example).toContain('"$OPENWIKI_GITLAB_TOKEN"');
    expect(example).toContain(
      'push "https://${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"',
    );
  });
});
