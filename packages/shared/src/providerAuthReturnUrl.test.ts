import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});

it.each([
  "https://code.example.test",
  "https://instance.tail123.ts.net",
  "http://instance.tail123.ts.net:8080",
])("accepts only the current instance origin %s", (origin) => {
  const value = `${origin}/settings/providers?instanceId=work&code=secret`;
  expect(providerAuthReturnUrl(value, origin)).toBe(`${origin}/settings/providers?instanceId=work`);
  expect(providerAuthReturnUrl(value)).toBeUndefined();
  for (const rejected of [
    "https://attacker.example/settings",
    `${origin}.attacker.example/settings`,
    `${origin.replace(/:\d+$/u, "")}:9999/settings`,
    `${origin}/evil`,
    `${origin.replace("://", "://user:password@")}/settings`,
  ]) {
    expect(providerAuthReturnUrl(rejected, origin)).toBeUndefined();
  }
});
