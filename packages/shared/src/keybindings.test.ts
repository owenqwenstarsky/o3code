import { describe, expect, it } from "vite-plus/test";

import { parseKeybindingShortcut } from "./keybindings.ts";

describe("parseKeybindingShortcut", () => {
  it("accepts a literal plus key only when the chord ends in ++", () => {
    expect(parseKeybindingShortcut("mod++")).toMatchObject({ key: "+", modKey: true });
    expect(parseKeybindingShortcut("+")).toMatchObject({ key: "+", modKey: false });
    expect(parseKeybindingShortcut("mod++ ")).toMatchObject({ key: "+", modKey: true });
    expect(parseKeybindingShortcut("mod+")).toBeNull();
    expect(parseKeybindingShortcut("mod+++")).toBeNull();
    expect(parseKeybindingShortcut(" ")).toBeNull();
    expect(parseKeybindingShortcut("")).toBeNull();
  });
});
