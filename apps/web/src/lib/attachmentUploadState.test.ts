import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { attachmentUploadBlockReason, type AttachmentUploadState } from "./attachmentUploadState";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");

const ready = (environment = environmentId): AttachmentUploadState => ({
  status: "ready",
  environmentId: environment,
  attachmentId: "pending-1",
});
const uploading: AttachmentUploadState = { status: "uploading", environmentId, progress: 0.5 };
const failed: AttachmentUploadState = { status: "failed", environmentId, reason: "offline" };

describe("attachmentUploadBlockReason", () => {
  it.each([
    { label: "every upload ready here", uploads: [ready()], expected: null },
    // Send retries failed uploads, so they must not disable it.
    { label: "a failed upload here", uploads: [failed], expected: null },
    {
      label: "one upload in flight",
      uploads: [ready(), uploading],
      expected: "Attachment still uploading",
    },
    {
      label: "several uploads in flight",
      uploads: [uploading, uploading],
      expected: "Attachments still uploading",
    },
    { label: "an unknown image", uploads: [], expected: "Attachment still uploading" },
    {
      label: "an upload from another environment",
      uploads: [ready(otherEnvironmentId)],
      expected: "Attachment still uploading",
    },
    {
      label: "a failed upload from another environment",
      uploads: [{ ...failed, environmentId: otherEnvironmentId }],
      expected: "Attachment still uploading",
    },
  ])("blocks sending with $label", ({ uploads, expected }) => {
    const imageIds =
      uploads.length === 0 ? ["image-0"] : uploads.map((_, index) => `image-${index}`);
    expect(
      attachmentUploadBlockReason({
        imageIds,
        environmentId,
        uploadsByImageId: Object.fromEntries(
          uploads.map((upload, index) => [`image-${index}`, upload]),
        ),
      }),
    ).toBe(expected);
  });
});
