import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  createSyntheticJwt,
  resolveCodexOAuthCredentials,
} from "../src/codex-oauth.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createAuthPath(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `openwiki-${name}-`));
  tempDirs.push(dir);
  return path.join(dir, "auth.json");
}

describe("resolveCodexOAuthCredentials — auth.json", () => {
  test("returns stored credentials without refreshing when the access token is still fresh", async () => {
    const now = new Date("2026-07-08T11:45:00.000Z");
    const authPath = await createAuthPath("codex-auth-fresh");
    const accessToken = createSyntheticJwt({
      exp: Math.floor((now.getTime() + 10 * 60 * 1000) / 1000),
    });
    const authJson = `${JSON.stringify(
      {
        tokens: {
          accessToken,
          refreshToken: "refresh-token",
          idToken: createSyntheticJwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_fresh",
              chatgpt_plan_type: "plus",
            },
          }),
          accountId: "acct_fresh",
          planType: "plus",
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        },
        updatedAt: "2026-07-08T10:00:00.000Z",
      },
      null,
      2,
    )}
`;
    const fetchMock = vi.fn<typeof fetch>();

    await writeFile(authPath, authJson, "utf8");

    await expect(
      resolveCodexOAuthCredentials({
        authPath,
        fetch: fetchMock,
        now,
      }),
    ).resolves.toEqual({
      accessToken,
      accountId: "acct_fresh",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFile(authPath, "utf8")).resolves.toBe(authJson);
  });

  test("refreshes an expired token and persists the rotated access token", async () => {
    const now = new Date("2026-07-08T11:45:00.000Z");
    const authPath = await createAuthPath("codex-auth-refresh");
    const expiredAccessToken = createSyntheticJwt({
      exp: Math.floor((now.getTime() - 60 * 1000) / 1000),
    });
    const refreshedAccessToken = createSyntheticJwt({
      exp: Math.floor((now.getTime() + 60 * 60 * 1000) / 1000),
    });
    const previousIdToken = createSyntheticJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_refresh",
        chatgpt_plan_type: "pro",
      },
    });
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: refreshedAccessToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          tokens: {
            accessToken: expiredAccessToken,
            refreshToken: "refresh-token-before-rotation",
            idToken: previousIdToken,
            accountId: "acct_refresh",
            planType: "pro",
            expiresAt: new Date(now.getTime() - 60 * 1000).toISOString(),
          },
          updatedAt: "2026-07-08T10:00:00.000Z",
        },
        null,
        2,
      )}
`,
      "utf8",
    );

    await expect(
      resolveCodexOAuthCredentials({
        authPath,
        fetch: fetchMock,
        now,
      }),
    ).resolves.toEqual({
      accessToken: refreshedAccessToken,
      accountId: "acct_refresh",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected refresh request body to be a JSON string.");
    }
    expect(JSON.parse(init.body)).toEqual({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-token-before-rotation",
    });

    const persisted = JSON.parse(await readFile(authPath, "utf8")) as {
      updatedAt: string;
      tokens: {
        accessToken: string;
        refreshToken: string;
        idToken: string;
        accountId: string;
        planType: string;
        expiresAt: string;
      };
    };
    expect(persisted.updatedAt).toBe(now.toISOString());
    expect(persisted.tokens.accountId).toBe("acct_refresh");
    expect(persisted.tokens.accessToken).toBe(refreshedAccessToken);
    expect(persisted.tokens.refreshToken).toBe(
      "refresh-token-before-rotation",
    );
    expect(persisted.tokens.idToken).toBe(previousIdToken);
    expect(persisted.tokens.planType).toBe("pro");
    expect(persisted.tokens.expiresAt).toBe(
      new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    );
  });

  test("rejects an auth file that is not valid JSON", async () => {
    const authPath = await createAuthPath("codex-auth-invalid-json");

    await writeFile(authPath, "{not-json}\n", "utf8");

    await expect(
      resolveCodexOAuthCredentials({ authPath }),
    ).rejects.toThrow(
      `Codex OAuth credentials at ${authPath} are not valid JSON.`,
    );
  });
});
