// @effect-diagnostics nodeBuiltinImport:off -- A dev launcher that supervises two watched node processes.
/**
 * `vp run dev:instance` backend: an O3 instance plus one T3 server standing in for every workspace
 * (the `static` runtime), with no Docker or tailnet. T3CODE_DEV_DOCKER=1 (`vp run dev --docker`)
 * instead runs real workspace containers in the local Docker, each on a loopback port.
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

const useDocker = process.env.T3CODE_DEV_DOCKER === "1";
const workspacePort = useDocker ? 0 : await freePort();
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
const adminEnv = {
  O3_INSTANCE_NAME: process.env.O3_INSTANCE_NAME ?? "O3 Code (dev)",
  O3_ADMIN_EMAIL: process.env.O3_ADMIN_EMAIL ?? "admin@o3.test",
  O3_ADMIN_PASSWORD: process.env.O3_ADMIN_PASSWORD ?? "o3-dev-password",
};
const watch = [
  "--watch",
  "--watch-path=src",
  "--watch-path=../../packages",
  "--watch-path=package.json",
];
const instanceArgs = (baseDir: string) => [
  ...watch,
  "src/bin.ts",
  "instance",
  "serve",
  "--port",
  String(instancePort),
  "--base-dir",
  baseDir,
];

const DEV_WORKSPACE_IMAGE = "o3code/workspace:dev";

// `--share` serves Vite on the tailnet; a remote browser can't reach a workspace's loopback
// port, so each is published the same way for as long as this runs.
const sharedHost = (() => {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!devUrl) return null;
  const url = new URL(devUrl);
  return url.protocol === "https:" && url.hostname.endsWith(".ts.net") ? url.hostname : null;
})();
const servedPorts = new Set<number>();
const servePort = (port: number) => {
  if (servedPorts.has(port)) return;
  servedPorts.add(port);
  NodeChildProcess.execFileSync("tailscale", [
    "serve",
    "--bg",
    `--https=${port}`,
    `http://127.0.0.1:${port}`,
  ]);
};
const unservePort = (port: number) => {
  if (!servedPorts.delete(port)) return;
  NodeChildProcess.spawnSync("tailscale", ["serve", `--https=${port}`, "off"]);
};
process.on("exit", () => {
  for (const port of servedPorts) unservePort(port);
});

const docker = (args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("docker", args, { encoding: "utf8" });

const startDockerInstance = () => {
  const context = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  const endpoint = context.status === 0 ? context.stdout.trim() : "";
  if (!endpoint.startsWith("unix://") || docker(["info", "--format", "{{.ID}}"]).status !== 0) {
    process.stderr.write("[dev-instance] Docker isn't running. Start Docker Desktop and retry.\n");
    process.exit(1);
  }
  const rebuild = process.env.T3CODE_DEV_DOCKER_REBUILD === "1";
  if (rebuild || docker(["image", "inspect", DEV_WORKSPACE_IMAGE]).status !== 0) {
    process.stdout.write(
      `[dev-instance] building ${DEV_WORKSPACE_IMAGE} from this checkout; the first build takes several minutes.\n`,
    );
    const build = NodeChildProcess.spawnSync(
      "docker",
      ["build", "-f", "docker/Dockerfile", "--target", "workspace", "-t", DEV_WORKSPACE_IMAGE, "."],
      { cwd: NodePath.resolve(serverDir, "../.."), stdio: "inherit" },
    );
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  // Per checkout, so a share publishes only this instance's workspaces.
  const network = `o3-dev-${NodeCrypto.createHash("sha256").update(home).digest("hex").slice(0, 10)}`;
  const children: Array<NodeChildProcess.ChildProcess> = [];
  if (sharedHost !== null) {
    // A recreated workspace gets a new container and port; the old port stops answering.
    const portByContainer = new Map<string, number>();
    const serveContainer = (id: string) => {
      const port = docker(["port", id, "3773/tcp"]).stdout.match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port === undefined) return;
      portByContainer.set(id, Number(port));
      servePort(Number(port));
    };
    const unserveContainer = (id: string) => {
      const port = portByContainer.get(id);
      portByContainer.delete(id);
      if (port !== undefined && ![...portByContainer.values()].includes(port)) unservePort(port);
    };
    const events = NodeChildProcess.spawn(
      "docker",
      [
        "events",
        "--filter",
        "type=network",
        "--filter",
        `network=${network}`,
        "--filter",
        "event=connect",
        "--filter",
        "event=disconnect",
        "--format",
        "{{.Action}} {{.Actor.Attributes.container}}",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    events.stdout.setEncoding("utf8");
    events.stdout.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const [action, id] = line.trim().split(" ");
        if (!id) continue;
        if (action === "connect") serveContainer(id);
        else unserveContainer(id);
      }
    });
    children.push(events);
    const running = docker(["ps", "-q", "--no-trunc", "--filter", `network=${network}`]).stdout;
    for (const id of running.split("\n")) if (id.trim()) serveContainer(id.trim());
  }
  const child = NodeChildProcess.spawn(
    process.execPath,
    // Its own state: the static runtime's records point at the stand-in, not at containers.
    instanceArgs(NodePath.join(home, "o3-instance-docker")),
    {
      cwd: serverDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...adminEnv,
        O3_WORKSPACE_RUNTIME: "docker",
        O3_WORKSPACE_PUBLISH: "loopback",
        O3_DOCKER_SOCKET: endpoint.slice("unix://".length),
        O3_WORKSPACE_NETWORK: network,
        O3_WORKSPACE_IMAGE: DEV_WORKSPACE_IMAGE,
        ...(sharedHost === null ? {} : { O3_WORKSPACE_PUBLISH_HOST: sharedHost }),
        // Containers reach the instance through Docker Desktop's host alias.
        O3_INSTANCE_URL: `http://host.docker.internal:${instancePort}`,
      },
    },
  );
  process.stdout.write(
    `[dev-instance] instance ${instanceUrl}, workspaces run in Docker (${DEV_WORKSPACE_IMAGE}; T3CODE_DEV_DOCKER_REBUILD=1 rebuilds it)${sharedHost === null ? "" : ` and are published on ${sharedHost}`}. First sign-in: ${adminEnv.O3_ADMIN_EMAIL} / ${adminEnv.O3_ADMIN_PASSWORD}\n`,
  );
  children.push(child);
  return children;
};

const startStaticInstance = () => {
  if (sharedHost !== null) servePort(workspacePort);
  const workspaceUrl =
    sharedHost === null
      ? `http://127.0.0.1:${workspacePort}`
      : `https://${sharedHost}:${workspacePort}`;

  const children = [
    NodeChildProcess.spawn(
      process.execPath,
      [...watch, "src/bin.ts", "serve", "--port", String(workspacePort), "--base-dir", home],
      {
        cwd: serverDir,
        stdio: "inherit",
        env: {
          ...process.env,
          // Keeps VITE_DEV_SERVER_URL: it registers the Replay (dev) provider and lets the
          // Vite origin call the workspace. Sign-in goes through the instance, not a dev token.
          T3CODE_DEV_AUTH_TOKEN: undefined,
          T3CODE_PORT: String(workspacePort),
          T3CODE_O3_INSTANCE_URL: instanceUrl,
          T3CODE_O3_WORKSPACE_ID: "static",
          T3CODE_O3_WORKSPACE_SECRET: secret,
        },
      },
    ),
    NodeChildProcess.spawn(process.execPath, instanceArgs(NodePath.join(home, "o3-instance")), {
      cwd: serverDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...adminEnv,
        O3_WORKSPACE_RUNTIME: "static",
        O3_STATIC_WORKSPACE_URL: workspaceUrl,
        O3_STATIC_WORKSPACE_SECRET: secret,
        O3_INSTANCE_URL: instanceUrl,
      },
    }),
  ];

  process.stdout.write(
    `[dev-instance] instance ${instanceUrl}, workspace ${workspaceUrl}. First sign-in: ${adminEnv.O3_ADMIN_EMAIL} / ${adminEnv.O3_ADMIN_PASSWORD}\n`,
  );
  return children;
};

const children = useDocker ? startDockerInstance() : startStaticInstance();

const stop = (signal: NodeJS.Signals) => {
  for (const child of children) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
// `node --watch` children outlive a parent that exits without signalling them.
process.on("exit", () => stop("SIGTERM"));
for (const child of children) {
  child.on("exit", (code) => {
    stop("SIGTERM");
    process.exitCode = code ?? 1;
  });
}
