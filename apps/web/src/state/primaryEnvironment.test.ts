import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { primaryEnvironmentIdIn } from "./primaryEnvironment";

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));

const workspace = (environmentId: string, connectionId: string) =>
  [
    EnvironmentId.make(environmentId),
    {
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make(environmentId),
        label: environmentId,
        connectionId,
      }),
    },
  ] as const;

it("picks the default workspace whatever its place in the catalog", () => {
  expect(
    primaryEnvironmentIdIn([
      workspace("frontend", "o3:frontend"),
      workspace("main", "o3:default:main"),
    ]),
  ).toBe("main");
  // A catalog saved before the default was marked still has a home.
  expect(primaryEnvironmentIdIn([workspace("main", "o3:main"), workspace("other", "pair-1")])).toBe(
    "main",
  );
  expect(primaryEnvironmentIdIn([workspace("other", "pair-1")])).toBeNull();
});
