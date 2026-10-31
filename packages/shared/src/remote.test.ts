import { describe, expect, it } from "vite-plus/test";

import { buildPairingAppLink } from "./remote.ts";

describe("buildPairingAppLink", () => {
  it("carries the pairing URL as an encoded query parameter", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const appLink = new URL(buildPairingAppLink(pairingUrl));
    expect(appLink.protocol).toBe("t3code:");
    expect(appLink.host).toBe("pair");
    expect(appLink.searchParams.get("pairingUrl")).toBe(pairingUrl);
  });
});
