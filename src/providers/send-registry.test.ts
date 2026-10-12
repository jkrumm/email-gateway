import { describe, expect, test } from "bun:test";
import { sendProvider, sendProviderByName } from "./send-registry";

describe("send registry", () => {
  test("sendProvider is the one SES provider", () => {
    expect(sendProvider().id).toBe("ses");
    expect(sendProvider()).toBe(sendProvider());
  });

  test("resolves ses by name", () => {
    expect(sendProviderByName("ses")).toBe(sendProvider());
  });

  test("an unknown name, such as a legacy resend row, is null", () => {
    expect(sendProviderByName("resend")).toBeNull();
  });
});
