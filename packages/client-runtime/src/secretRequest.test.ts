import {
  SecretRequestError,
  SecretRequestAnswerInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});

it("preserves every character of a non-empty secret through the client and wire codec", () => {
  const item = { threadId: ThreadId.make("thread"), id: TurnItemId.make("item") };
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(SecretRequestAnswerInput));
  for (const secret of ["  token\n", " ", "\tpassword\t"]) {
    const input = {
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save" as const, secret },
    };
    expect(decode(input)).toEqual(input);
    expect(secretRequestAnswerInput(item, input.answer)).toEqual(input);
  }
  expect(secretRequestAnswerInput(item, { type: "save", secret: "" })).toBeNull();
  expect(() =>
    decode({ threadId: item.threadId, turnItemId: item.id, answer: { type: "save", secret: "" } }),
  ).toThrow();
});
