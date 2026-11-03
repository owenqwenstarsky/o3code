import { expect, it, vi } from "vite-plus/test";

import { serverPictureInPictureKey } from "./serverPictureInPicture";

vi.mock("~/state/previewStream", () => ({}));
vi.mock("~/previewStateStore", () => ({}));
vi.mock("~/rpc/atomRegistry", () => ({}));

it("keeps players for matching thread and tab ids in different environments distinct", () => {
  expect(serverPictureInPictureKey("thread", "tab", "first")).not.toBe(
    serverPictureInPictureKey("thread", "tab", "second"),
  );
});
