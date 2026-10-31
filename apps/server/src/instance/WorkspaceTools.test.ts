// @effect-diagnostics nodeBuiltinImport:off -- Reads repository files directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { WORKSPACE_TOOLS } from "./WorkspaceTools.ts";

it("has an install script in the workspace image for every catalog tool", () => {
  const toolsDir = NodePath.resolve(import.meta.dirname, "../../../../docker/tools");
  const scripts = NodeFS.readdirSync(toolsDir).map((name) => name.replace(/\.sh$/, ""));
  expect(scripts.toSorted()).toEqual(WORKSPACE_TOOLS.map((tool) => tool.id).toSorted());
});
