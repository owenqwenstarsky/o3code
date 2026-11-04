import { expect, it, vi } from "vite-plus/test";
import { fetchLatestRelease, RELEASES_URL } from "./releases.ts";

it.each(["stable", "nightly"] as const)(
  "fetches fork %s releases without reusing upstream cache",
  async (channel) => {
    const release = {
      tag_name: channel === "stable" ? "v1.0.0" : "v1.0.1-nightly.1",
      html_url: "https://github.com/owenqwenstarsky/o3code/releases/tag/test",
      assets: [{ name: "app.dmg", browser_download_url: "https://example.test/app.dmg" }],
    };
    const cache = new Map([[`t3code-${channel}-release`, JSON.stringify({ assets: [] })]]);
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(channel === "stable" ? release : [release])));
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => cache.get(key) ?? null,
      setItem: (key: string, value: string) => cache.set(key, value),
    });
    try {
      expect(await fetchLatestRelease(channel)).toEqual(release);
      expect(fetch).toHaveBeenCalledWith(
        `https://api.github.com/repos/owenqwenstarsky/o3code/releases${channel === "stable" ? "/latest" : "?per_page=10"}`,
      );
      expect(RELEASES_URL).toBe("https://github.com/owenqwenstarsky/o3code/releases");
      expect(await fetchLatestRelease(channel)).toEqual(release);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
