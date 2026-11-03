import { isLoopbackHost } from "./preview.ts";

// The trusted origin comes from the current client location, never from the return URL.
export function providerAuthReturnUrl(
  value: string | undefined,
  instanceOrigin?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["t3code:", "t3code-dev:"].includes(url.protocol) && url.host === "app";
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) ||
        url.origin === "https://app.t3.codes" ||
        url.origin === instanceOrigin);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
