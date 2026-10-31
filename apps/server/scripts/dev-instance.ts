// @effect-diagnostics nodeBuiltinImport:off -- A dev launcher that supervises two watched node processes.
/**
 * `vp run dev:instance` backend: an O3 instance on T3CODE_PORT plus one T3 server that stands in
 * for every user's workspace (the instance's `static` runtime), so the full sign-in flow runs
 * without Docker or a tailnet. The workspace uses this checkout's dev home, the instance a
 * subdirectory of it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as Effect from "effect/Effect";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const instancePort = Number(process.env.T3CODE_PORT ?? 3773);

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const workspacePort = await freePort();
const worktreeHome = await Effect.runPromise(
  resolveWorktreeT3Home(serverDir).pipe(Effect.provide(NodeServices.layer)),
);
const home = process.env.T3CODE_HOME ?? worktreeHome;
if (home === undefined) {
  // Outside a worktree the default would be ~/.t3, the developer's live install.
  process.stderr.write("[dev-instance] Set T3CODE_HOME or run from a git worktree.\n");
  process.exit(1);
}
const secret = NodeCrypto.randomBytes(24).toString("base64url");
const instanceUrl = `http://127.0.0.1:${instancePort}`;
const workspaceUrl = `http://127.0.0.1:${workspacePort}`;

const watch = [
  "--watch",
  "--watch-path=src",
  "--watch-path=../../packages",
  "--watch-path=package.json",
];

const children = [
  NodeChildProcess.spawn(
    process.execPath,
    [...watch, "src/bin.ts", "serve", "--port", String(workspacePort), "--base-dir", home],
    {
      cwd: serverDir,
      stdio: "inherit",
      env: {
        ...process.env,
        // The workspace is reached directly by the browser, never through Vite.
        VITE_DEV_SERVER_URL: undefined,
        T3CODE_DEV_AUTH_TOKEN: undefined,
        T3CODE_PORT: String(workspacePort),
        T3CODE_O3_INSTANCE_URL: instanceUrl,
        T3CODE_O3_USER_ID: "static",
        T3CODE_O3_WORKSPACE_SECRET: secret,
      },
    },
  ),
  NodeChildProcess.spawn(
    process.execPath,
    [
      ...watch,
      "src/bin.ts",
      "instance",
      "serve",
      "--port",
      String(instancePort),
      "--base-dir",
      NodePath.join(home, "o3-instance"),
    ],
    {
      cwd: serverDir,
      stdio: "inherit",
      env: {
        ...process.env,
        O3_WORKSPACE_RUNTIME: "static",
        O3_STATIC_WORKSPACE_URL: workspaceUrl,
        O3_STATIC_WORKSPACE_SECRET: secret,
        O3_INSTANCE_URL: instanceUrl,
        O3_INSTANCE_NAME: process.env.O3_INSTANCE_NAME ?? "O3 Code (dev)",
        O3_ADMIN_EMAIL: process.env.O3_ADMIN_EMAIL ?? "admin@o3.test",
        O3_ADMIN_PASSWORD: process.env.O3_ADMIN_PASSWORD ?? "o3-dev-password",
      },
    },
  ),
];

process.stdout.write(
  `[dev-instance] instance ${instanceUrl}, workspace ${workspaceUrl}. First sign-in: ${process.env.O3_ADMIN_EMAIL ?? "admin@o3.test"} / ${process.env.O3_ADMIN_PASSWORD ?? "o3-dev-password"}` +
    "\n",
);

const stop = (signal: NodeJS.Signals) => {
  for (const child of children) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
for (const child of children) {
  child.on("exit", (code) => {
    stop("SIGTERM");
    process.exitCode = code ?? 1;
  });
}
