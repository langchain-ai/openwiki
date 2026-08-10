import { EventEmitter } from "node:events";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// startNgrokTunnel persists the resolved redirect config through the env file.
// The save is mocked so no test touches ~/.openwiki/.env: the validation cases
// throw before any save or `ngrok` spawn, and the tunnel-lifecycle cases below
// assert on the mock's calls instead of writing real credentials to disk. The
// mock is hoisted so those cases can inspect exactly what was persisted.
const saveOpenWikiEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../src/config/env.ts", () => ({
  saveOpenWikiEnv: saveOpenWikiEnvMock,
}));

// `startNgrokTunnel` shells out to the real `ngrok` binary via child_process.
// The spawn is mocked to hand back a controllable fake child so the suite never
// launches a subprocess, and so it can assert the exact argv and `shell:false`
// that keep operator-supplied ports/URLs from being reinterpreted by a shell.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  getRedirectUriFromNgrokTunnels,
  startNgrokTunnel,
} from "../../src/auth/ngrok.ts";

const PORT = 53682;

/**
 * A fake ngrok child process. `waitForNgrokExit` only listens for the "error"
 * and "exit" events, so an EventEmitter is a faithful stand-in that lets a test
 * drive either outcome deterministically without a real subprocess.
 */
function fakeChild(): EventEmitter {
  const child = new EventEmitter();
  spawnMock.mockReturnValue(child);
  return child;
}

/**
 * Drains queued microtasks (via a macrotask boundary) so the mocked `spawn`
 * runs and `waitForNgrokExit` registers its listeners before the test emits an
 * exit/error event. `setImmediate` runs only after the microtask queue is fully
 * drained, so a single await settles the whole promise chain up to the point
 * where the code parks on the child's exit. It is real-timer safe and never
 * waits on the wall clock.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a fake `fetch` Response exposing just the `ok`/`json` surface that
 * `fetchNgrokRedirectUri` consumes from the ngrok local API.
 */
function fetchResponse(
  ok: boolean,
  body: unknown,
): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok,
    json: () => Promise.resolve(body),
  };
}

/**
 * Builds an ngrok `/api/tunnels` style payload from tunnel descriptors.
 */
function tunnels(entries: { addr?: string; public_url: string }[]): {
  tunnels: unknown[];
} {
  return {
    tunnels: entries.map(({ addr, public_url }) => ({
      config: addr === undefined ? {} : { addr },
      public_url,
    })),
  };
}

describe("getRedirectUriFromNgrokTunnels", () => {
  test("returns null when the payload is not a tunnels object", () => {
    expect(getRedirectUriFromNgrokTunnels(null, PORT)).toBeNull();
    expect(getRedirectUriFromNgrokTunnels({}, PORT)).toBeNull();
    expect(
      getRedirectUriFromNgrokTunnels({ tunnels: "nope" }, PORT),
    ).toBeNull();
  });

  test("builds a callback URL from the tunnel whose addr matches the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://other.ngrok.app" },
      { addr: "http://localhost:53682", public_url: "https://match.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("matches a bare port addr and strips a trailing slash", () => {
    const payload = tunnels([
      { addr: String(PORT), public_url: "https://match.ngrok.app/" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://match.ngrok.app/callback",
    );
  });

  test("falls back to the sole https tunnel when none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:9999", public_url: "https://only.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://only.ngrok.app/callback",
    );
  });

  test("returns null when several tunnels exist but none match the port", () => {
    const payload = tunnels([
      { addr: "localhost:1111", public_url: "https://a.ngrok.app" },
      { addr: "localhost:2222", public_url: "https://b.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores non-https tunnels", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "http://insecure.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("ignores tunnels whose public url carries a port, query, or credentials", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "https://a.ngrok.app:8443" },
      { addr: `localhost:${PORT}`, public_url: "https://b.ngrok.app?x=1" },
      { addr: `localhost:${PORT}`, public_url: "https://user:pw@c.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });

  test("skips tunnel entries that are not objects or lack a public url", () => {
    // The ngrok API is trusted loosely: a null entry or one missing public_url
    // must be dropped rather than crash discovery, while a valid sibling still
    // resolves.
    const payload = {
      tunnels: [
        null,
        { config: { addr: `localhost:${PORT}` } },
        { config: { addr: `localhost:${PORT}` }, public_url: 42 },
        {
          config: { addr: `localhost:${PORT}` },
          public_url: "https://ok.ngrok.app",
        },
      ],
    };

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://ok.ngrok.app/callback",
    );
  });

  test("skips tunnels whose public url does not parse", () => {
    const payload = tunnels([
      { addr: `localhost:${PORT}`, public_url: "://not-a-url" },
      { addr: `localhost:${PORT}`, public_url: "https://parses.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://parses.ngrok.app/callback",
    );
  });

  test("treats a tunnel with no addr as non-matching but still usable as the sole fallback", () => {
    // A tunnel config lacking an `addr` yields an empty string; the port match
    // short-circuits to false rather than throwing, and the sole https tunnel
    // is still returned as the fallback.
    const payload = tunnels([
      { addr: undefined, public_url: "https://noaddr.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://noaddr.ngrok.app/callback",
    );
  });

  test("treats an unparseable addr as non-matching without throwing", () => {
    // A non-empty addr that is neither a bare port, a `:port` suffix, nor a
    // parseable URL must fail the port match via the caught URL parse error,
    // leaving the sole https tunnel as the fallback.
    const payload = tunnels([
      { addr: "garbage", public_url: "https://weirdaddr.ngrok.app" },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://weirdaddr.ngrok.app/callback",
    );
  });

  test("matches a full-url addr by parsing out its port", () => {
    // The addr is a full URL that does not literally end in `:53682`, so the
    // match must come from URL parsing rather than the suffix shortcut.
    const payload = tunnels([
      {
        addr: "http://127.0.0.1:53682/callback",
        public_url: "https://a.ngrok.app",
      },
      {
        addr: "http://127.0.0.1:9999/callback",
        public_url: "https://b.ngrok.app",
      },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBe(
      "https://a.ngrok.app/callback",
    );
  });

  test("does not match a full-url addr whose parsed port differs", () => {
    const payload = tunnels([
      {
        addr: "http://127.0.0.1:1111/callback",
        public_url: "https://a.ngrok.app",
      },
      {
        addr: "http://127.0.0.1:2222/callback",
        public_url: "https://b.ngrok.app",
      },
    ]);

    expect(getRedirectUriFromNgrokTunnels(payload, PORT)).toBeNull();
  });
});

describe("startNgrokTunnel validation", () => {
  // Every case here rejects during synchronous validation, before saveOpenWikiEnv
  // or the ngrok spawn, so a bad operator input never brings up a tunnel.
  test.each([80, 70000, 1024.5])(
    "rejects a local port outside the unprivileged TCP range: %s",
    async (port) => {
      await expect(startNgrokTunnel({ port })).rejects.toThrow(
        "ngrok local port must be between 1024 and 65535.",
      );
    },
  );

  test("rejects a custom url that is not https", async () => {
    // A plaintext tunnel would ship the OAuth redirect over http, so it is
    // refused rather than silently downgraded.
    await expect(
      startNgrokTunnel({ url: "http://tunnel.ngrok.app" }),
    ).rejects.toThrow("ngrok custom URL must use https.");
  });

  test("rejects a custom url that carries credentials, query, or fragment", async () => {
    for (const url of [
      "https://user:pw@tunnel.ngrok.app",
      "https://tunnel.ngrok.app/?token=abc",
      "https://tunnel.ngrok.app/#frag",
    ]) {
      await expect(startNgrokTunnel({ url })).rejects.toThrow(
        "ngrok custom URL must not include credentials, query, or fragment.",
      );
    }
  });

  test("rejects a custom url that pins a port", async () => {
    await expect(
      startNgrokTunnel({ url: "https://tunnel.ngrok.app:8443" }),
    ).rejects.toThrow("ngrok custom URL must not include a port.");
  });

  test("rejects a custom url whose path is neither empty nor /callback", async () => {
    await expect(
      startNgrokTunnel({ url: "https://tunnel.ngrok.app/elsewhere" }),
    ).rejects.toThrow("ngrok custom URL path must be empty or /callback.");
  });

  test("rejects a custom url without a valid dns hostname", async () => {
    // Underscores are not legal DNS label characters; the hostname guard keeps
    // a bogus authority from being registered as a Slack redirect.
    await expect(startNgrokTunnel({ url: "https://bad_host" })).rejects.toThrow(
      "ngrok custom URL must include a valid DNS hostname.",
    );
  });
});

describe("startNgrokTunnel with a fixed custom url", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    saveOpenWikiEnvMock.mockClear();
    spawnMock.mockReset();
    // The production code streams progress to stdout; silence and capture it so
    // the test output stays clean and the messages can be asserted.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test("spawns ngrok with a pinned --url and no shell, then resolves on clean exit", async () => {
    const child = fakeChild();

    // A bare host (no scheme) exercises the https:// prepend and the success
    // return of normalizeNgrokUrl.
    const pending = startNgrokTunnel({ url: "custom.ngrok.app" });
    await flushMicrotasks();

    // argv-injection safety: the port and pinned URL are passed as discrete argv
    // entries with shell:false, so a shell can never re-parse them.
    expect(spawnMock).toHaveBeenCalledWith(
      "ngrok",
      ["http", String(PORT), "--url", "https://custom.ngrok.app"],
      { shell: false, stdio: "inherit" },
    );

    child.emit("exit", 0);

    await expect(pending).resolves.toEqual({
      baseUrl: "https://custom.ngrok.app",
      port: PORT,
      redirectUri: "https://custom.ngrok.app/callback",
    });

    // With a pinned URL the redirect is known up front, so it is persisted
    // directly and the local-API discovery poll is skipped entirely.
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith({
      OPENWIKI_OAUTH_CALLBACK_PORT: String(PORT),
      OPENWIKI_HTTPS_OAUTH_REDIRECT_URI: "https://custom.ngrok.app/callback",
    });
  });

  test("accepts an explicit /callback path on the custom url", async () => {
    const child = fakeChild();

    const pending = startNgrokTunnel({
      port: 8080,
      url: "https://custom.ngrok.app/callback",
    });
    await flushMicrotasks();

    expect(spawnMock).toHaveBeenCalledWith(
      "ngrok",
      ["http", "8080", "--url", "https://custom.ngrok.app"],
      { shell: false, stdio: "inherit" },
    );

    child.emit("exit", 0);
    await expect(pending).resolves.toMatchObject({
      redirectUri: "https://custom.ngrok.app/callback",
    });
  });

  test("treats a SIGINT shutdown as a clean exit", async () => {
    // An operator pressing Ctrl-C stops the tunnel intentionally, so the signal
    // must resolve rather than surface as an ngrok failure.
    const child = fakeChild();

    const pending = startNgrokTunnel({ url: "https://custom.ngrok.app" });
    await flushMicrotasks();
    child.emit("exit", null, "SIGINT");

    await expect(pending).resolves.toMatchObject({ port: PORT });
  });

  test("rejects when ngrok cannot be spawned", async () => {
    // A missing binary surfaces as an "error" event; the wrapper wraps it with
    // context so the caller learns ngrok never started.
    const child = fakeChild();

    const pending = startNgrokTunnel({ url: "https://custom.ngrok.app" });
    await flushMicrotasks();
    child.emit("error", new Error("ENOENT"));

    await expect(pending).rejects.toThrow("Could not start ngrok: ENOENT");
  });

  test("wraps a non-Error spawn failure with a generic message", async () => {
    // The "error" payload is typed as Error but is not guaranteed to be one; a
    // non-Error value must still yield a clean message rather than leaking
    // undefined from `.message`.
    const child = fakeChild();

    const pending = startNgrokTunnel({ url: "https://custom.ngrok.app" });
    await flushMicrotasks();
    child.emit("error", "boom");

    await expect(pending).rejects.toThrow("Could not start ngrok.");
  });

  test("rejects when ngrok exits non-zero", async () => {
    const child = fakeChild();

    const pending = startNgrokTunnel({ url: "https://custom.ngrok.app" });
    await flushMicrotasks();
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      "ngrok exited with code=1 signal=null.",
    );
  });
});

describe("startNgrokTunnel with a random url (local-API discovery)", () => {
  let stdoutSpy: MockInstance;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    saveOpenWikiEnvMock.mockClear();
    spawnMock.mockReset();
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("spawns ngrok with no --url and discovers the redirect from the ngrok API", async () => {
    const child = fakeChild();
    fetchMock.mockResolvedValue(
      fetchResponse(
        true,
        tunnels([
          { addr: `localhost:${PORT}`, public_url: "https://random.ngrok.app" },
        ]),
      ),
    );

    const pending = startNgrokTunnel({ url: null });
    await flushMicrotasks();

    // No pinned URL means no `--url` flag; ngrok picks the forwarding host.
    expect(spawnMock).toHaveBeenCalledWith("ngrok", ["http", String(PORT)], {
      shell: false,
      stdio: "inherit",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4040/api/tunnels");

    child.emit("exit", 0);

    // The discovered value is only persisted to env; the resolved result keeps
    // the empty base/redirect that the random-URL branch returns.
    await expect(pending).resolves.toEqual({
      baseUrl: "",
      port: PORT,
      redirectUri: "",
    });
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith({
      OPENWIKI_OAUTH_CALLBACK_PORT: String(PORT),
      OPENWIKI_HTTPS_OAUTH_REDIRECT_URI: "https://random.ngrok.app/callback",
    });
  });

  test("retries the poll until the tunnel is ready, tolerating a fetch error and an empty payload", async () => {
    // The poll loop uses a real 500ms sleep between attempts; fake timers make
    // the retry deterministic instead of racing the wall clock.
    vi.useFakeTimers();
    const child = fakeChild();
    fetchMock
      // First attempt: ngrok API not up yet -> fetch rejects (caught -> null).
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      // Second attempt: API up but no matching tunnel yet -> null redirect.
      .mockResolvedValueOnce(fetchResponse(true, { tunnels: [] }))
      // Third attempt: tunnel ready.
      .mockResolvedValue(
        fetchResponse(
          true,
          tunnels([
            {
              addr: `localhost:${PORT}`,
              public_url: "https://ready.ngrok.app",
            },
          ]),
        ),
      );

    const pending = startNgrokTunnel({ url: null });

    // Advance across two 500ms sleeps so the third fetch discovers the tunnel.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    child.emit("exit", 0);
    await pending;

    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith({
      OPENWIKI_OAUTH_CALLBACK_PORT: String(PORT),
      OPENWIKI_HTTPS_OAUTH_REDIRECT_URI: "https://ready.ngrok.app/callback",
    });
  });

  test("gives up after the discovery timeout without persisting a redirect", async () => {
    // A ngrok that never exposes a usable tunnel must not hang the caller: after
    // the 15s discovery window the poll returns null and the code prints manual
    // instructions instead of saving a redirect.
    vi.useFakeTimers();
    const child = fakeChild();
    fetchMock.mockResolvedValue(fetchResponse(false, {}));

    const pending = startNgrokTunnel({ url: null });

    // Exhaust the whole 15s discovery budget (30 polls at 500ms apart).
    await vi.advanceTimersByTimeAsync(15_000);

    child.emit("exit", 0);
    await pending;

    // Only the initial "clear the redirect" save happened; discovery saved
    // nothing because no redirect was ever found.
    expect(saveOpenWikiEnvMock).toHaveBeenCalledTimes(1);
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith({
      OPENWIKI_OAUTH_CALLBACK_PORT: String(PORT),
      OPENWIKI_HTTPS_OAUTH_REDIRECT_URI: "",
    });
  });

  test("ends discovery early when ngrok exits before a tunnel appears", async () => {
    // The discovery poll races the process exit; if ngrok dies first the race
    // resolves via the exit and a non-zero code still surfaces as a failure.
    vi.useFakeTimers();
    const child = fakeChild();
    fetchMock.mockResolvedValue(fetchResponse(false, {}));

    const pending = startNgrokTunnel({ url: null });
    // Drain the pre-spawn microtasks (fake timers stub setImmediate, so advance
    // by 0 to settle them) until the exit listener is registered, then kill it.
    await vi.advanceTimersByTimeAsync(0);
    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      "ngrok exited with code=1 signal=null.",
    );
  });
});
