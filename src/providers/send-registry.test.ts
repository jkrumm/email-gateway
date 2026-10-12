import { describe, expect, test } from "bun:test";
import {
  sendProviderByName,
  sendProviderFor,
  statusProviders,
} from "./send-registry";

// The test env leaves SES unset, like prod: default behaviour is unchanged.
describe("send registry with SES unconfigured", () => {
  test("sends still resolve to resend", () => {
    expect(sendProviderFor(undefined).id).toBe("resend");
  });

  test("building ses throws a clear error", () => {
    expect(() => sendProviderByName("ses")).toThrow("SES is not configured");
  });

  test("statusProviders skips ses instead of throwing", () => {
    expect(Object.keys(statusProviders())).toEqual(["resend"]);
  });

  test("an unknown name is null", () => {
    expect(sendProviderByName("mailgun")).toBeNull();
  });
});
