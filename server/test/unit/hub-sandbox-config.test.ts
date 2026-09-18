// hub-sandbox-config.test.ts — §23.8's configuration and image pins, checked as a
// contract between files rather than as prose.
//
// The image line and the SDK version must move together (the control protocol is versioned
// with the package), the wrangler container entry must agree with the compiled container
// cap, the Deno base must be a pinned release, the runner's permission flags must be the
// ones `hubRunArgv` builds, and the immutable file set must be the one the supervisor
// copies. Each of those is a cross-file fact no single module can hold, so the test reads
// the files and compares them to the exported constants.
//
// deps: node:fs · limits · hub-runtime (pure constants)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HUB_SANDBOX_CONTAINERS_MAX } from "../../src/limits";
import {
  HUB_BRIDGE_HOST,
  HUB_IMAGE_DIRECTORY,
  HUB_NONCE_ENV,
  HUB_RUN_DIRECTORY,
  HUB_RUN_FILE,
  HUB_RUNNER_FILE,
  hubCheckArgv,
  hubRunArgv,
} from "../../src/hub-runtime";

// `import.meta.dirname` is a node16/nodenext-module feature; this repo compiles with
// `module: ESNext`, so the directory is derived from the module URL instead.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

/** wrangler.jsonc carries line comments only; strip them and parse. */
function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
}

describe("sandbox dependency and image pins", () => {
  it("pins the SDK to exactly the release the Dockerfile copies the control binary from", () => {
    const manifest = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    const version = manifest.dependencies["@cloudflare/sandbox"];
    expect(version).toBe("0.13.0-next.751.1");
    const dockerfile = read("server/sandbox/Dockerfile");
    expect(dockerfile).toContain(`ARG SANDBOX_IMAGE=cloudflare/sandbox:${version}`);
  });

  it("pins a Deno release as the base image", () => {
    const dockerfile = read("server/sandbox/Dockerfile");
    const match = /ARG DENO_IMAGE=denoland\/deno:(\d+\.\d+\.\d+)$/m.exec(dockerfile);
    expect(match?.[1]).toBe("2.9.6");
  });

  it("ships the immutable runtime files at the image directory the supervisor copies from", () => {
    const dockerfile = read("server/sandbox/Dockerfile");
    expect(dockerfile).toContain(`COPY ${HUB_RUNNER_FILE} worker.ts deno.json ${HUB_IMAGE_DIRECTORY}/`);
    expect(dockerfile).toContain("ENTRYPOINT");
    expect(dockerfile).toContain("/container-server/sandbox");
  });
});

describe("wrangler execution plane", () => {
  const config = parseJsonc(read("wrangler.jsonc"));

  it("enables the request signal flag the abort path depends on", () => {
    expect(config.compatibility_flags).toContain("enable_request_signal");
    expect(config.compatibility_flags).toContain("nodejs_compat");
  });

  it("binds the HubSandbox DO beside AppConnection without disturbing it", () => {
    const durableObjects = config.durable_objects as { bindings: { name: string; class_name: string }[] };
    expect(durableObjects.bindings).toContainEqual({ name: "APP_CONNECTION", class_name: "AppConnection" });
    expect(durableObjects.bindings).toContainEqual({ name: "HUB_SANDBOX", class_name: "HubSandbox" });
  });

  it("declares the container with the compiled caps and the repository image", () => {
    const containers = config.containers as { class_name: string; image: string; instance_type: string; max_instances: number }[];
    expect(containers).toHaveLength(1);
    expect(containers[0]).toEqual({
      class_name: "HubSandbox",
      image: "./server/sandbox/Dockerfile",
      instance_type: "basic",
      max_instances: HUB_SANDBOX_CONTAINERS_MAX,
    });
  });

  it("appends the SQLite migration and leaves AppConnection's history untouched", () => {
    const migrations = config.migrations as { tag: string; new_sqlite_classes?: string[]; renamed_classes?: { from: string; to: string }[] }[];
    expect(migrations[0]).toEqual({ tag: "v1", new_sqlite_classes: ["ServiceConnection"] });
    expect(migrations[1]).toEqual({ tag: "v2", renamed_classes: [{ from: "ServiceConnection", to: "AppConnection" }] });
    expect(migrations[2]).toEqual({ tag: "v3", new_sqlite_classes: ["HubSandbox"] });
  });
});

describe("trusted parent argv", () => {
  const runner = read("server/sandbox/runner.ts");

  it("matches the coordinator's run argv, flag for flag", () => {
    const argv = hubRunArgv();
    expect(argv).toContain(`--allow-net=${HUB_BRIDGE_HOST}:80`);
    expect(argv).toContain(`--allow-read=${HUB_RUN_DIRECTORY}`);
    expect(argv).toContain(`--allow-write=${HUB_RUN_DIRECTORY}/${HUB_RUN_FILE.result}`);
    expect(argv).toContain(`--allow-env=${HUB_NONCE_ENV}`);
    // Every flag the coordinator builds is the one the parent's documentation names, so a
    // drift between the two is a test failure rather than a silent permission widening.
    for (const flag of argv.filter((entry) => entry.startsWith("--"))) {
      expect(runner, `runner.ts does not mention ${flag}`).toContain(flag);
    }
  });

  it("keeps the checker invocation offline and bounded by the same constants", () => {
    const check = hubCheckArgv();
    expect(check).toContain("check");
    expect(check).toContain("--frozen");
    expect(check).toContain("--cached-only");
    expect(check).toContain("--no-remote");
    expect(check).toContain("--no-npm");
    expect(check.at(-1)).toBe(HUB_RUN_FILE.program);
  });

  it("never mentions a consumer credential or the sandbox key", () => {
    for (const source of [runner, read("server/sandbox/worker.ts")]) {
      expect(source).not.toContain("sandboxKey");
      expect(source).not.toContain("pmcp_agt_");
      expect(source).not.toContain("pmcp_adm_");
    }
  });
});

describe("container runtime files", () => {
  const worker = read("server/sandbox/worker.ts");

  it("installs a read-only mcp global before the program is imported", () => {
    const installAt = worker.indexOf("Object.defineProperty(globalThis, \"mcp\"");
    const importAt = worker.indexOf('await import("./program.ts")');
    expect(installAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(installAt);
    expect(worker).toContain("writable: false");
    expect(worker).toContain("configurable: false");
  });

  it("offers no recursive execute and no generic canonical call", () => {
    expect(worker).not.toContain("hub.execute");
    expect(worker).not.toContain("execute:");
  });

  it("reads the snapshot and writes the one envelope path the parent is granted", () => {
    expect(read("server/sandbox/runner.ts")).toContain(HUB_RUN_FILE.result);
    expect(read("server/sandbox/runner.ts")).toContain(HUB_RUN_FILE.snapshot);
  });

  it("names only program.d.ts as a checker type", () => {
    const deno = JSON.parse(read("server/sandbox/deno.json")) as { compilerOptions: { types: string[] } };
    expect(deno.compilerOptions.types).toEqual(["./program.d.ts"]);
  });

  it("sets the container's egress and idle policy in the DO class", () => {
    const sandbox = read("server/src/hub-sandbox.ts");
    expect(sandbox).toContain("override enableInternet = false");
    expect(sandbox).toContain("override sleepAfter = HUB_SANDBOX_SLEEP_AFTER");
    expect(sandbox).toContain("export const HUB_SANDBOX_SLEEP_AFTER = \"6m\"");
    expect(sandbox).toContain("HubSandbox.outboundByHost");
  });
});
