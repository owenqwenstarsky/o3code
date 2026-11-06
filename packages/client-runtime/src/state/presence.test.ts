import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import { formatTypingLabel, otherMemberTurnOwner, selectThreadPresence } from "./presence.ts";

describe("formatTypingLabel", () => {
  it.each([
    [[], null],
    [["Alex"], "Alex is typing…"],
    [["Alex", "Sam"], "Alex and Sam are typing…"],
    [["Alex", "Sam", "Jo"], "Alex, Sam and Jo are typing…"],
    [["Alex", "Sam", "Jo", "Kim"], "Alex, Sam and 2 others are typing…"],
  ])("%j → %s", (names, label) => {
    expect(formatTypingLabel(names)).toBe(label);
  });
});

describe("selectThreadPresence", () => {
  it("counts typers as viewers of the thread they type in", () => {
    const threadA = ThreadId.make("thread:a");
    const threadB = ThreadId.make("thread:b");
    const presence = selectThreadPresence(
      {
        viewerUserId: "alex",
        members: [
          { userId: "sam", name: "Sam", viewingThreadIds: [threadA], typingThreadIds: [] },
          { userId: "jo", name: "Jo", viewingThreadIds: [], typingThreadIds: [threadA] },
          { userId: "kim", name: "Kim", viewingThreadIds: [threadB], typingThreadIds: [] },
        ],
      },
      threadA,
    );
    expect(presence.viewers.map((member) => member.name)).toEqual(["Sam", "Jo"]);
    expect(presence.typers.map((member) => member.name)).toEqual(["Jo"]);
  });
});

describe("otherMemberTurnOwner", () => {
  const sam = { userId: "sam", name: "Sam" };
  const input = {
    runs: [{ id: "run", userMessageId: "message" }],
    messages: [{ id: "message", author: sam }],
    activeRunId: "run",
  };

  it("names another member's running turn, not your own or an unattributed one", () => {
    expect(otherMemberTurnOwner({ ...input, viewerUserId: "alex" })).toEqual(sam);
    expect(otherMemberTurnOwner({ ...input, viewerUserId: "sam" })).toBeNull();
    expect(otherMemberTurnOwner({ ...input, viewerUserId: null })).toBeNull();
    expect(
      otherMemberTurnOwner({ ...input, messages: [{ id: "message" }], viewerUserId: "alex" }),
    ).toBeNull();
    expect(otherMemberTurnOwner({ ...input, activeRunId: null, viewerUserId: "alex" })).toBeNull();
  });
});
