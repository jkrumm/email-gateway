import { describe, expect, test } from "bun:test";
import { TEMPLATE_IDS } from "../emails/registry";
import {
  parseSendProviders,
  resolveSendProviderName,
  sesConfigured,
} from "./send-select";

describe("parseSendProviders", () => {
  test("unset, empty and blank all mean no overrides", () => {
    for (const raw of [undefined, "", "  ", " , "]) {
      expect(parseSendProviders(raw)).toEqual({ map: {}, issues: [] });
    }
  });

  test("parses templateId=provider pairs, trimming whitespace", () => {
    const { map, issues } = parseSendProviders(
      ` ${TEMPLATE_IDS.fppSender} = resend , ${TEMPLATE_IDS.fppReceiver}=resend,`,
    );

    expect(issues).toEqual([]);
    expect(map).toEqual({
      [TEMPLATE_IDS.fppSender]: "resend",
      [TEMPLATE_IDS.fppReceiver]: "resend",
    });
  });

  test("ses is a known provider", () => {
    const { map, issues } = parseSendProviders(`${TEMPLATE_IDS.fppSender}=ses`);

    expect(issues).toEqual([]);
    expect(map).toEqual({ [TEMPLATE_IDS.fppSender]: "ses" });
  });

  test("an unknown provider name is an issue", () => {
    const { map, issues } = parseSendProviders(
      `${TEMPLATE_IDS.fppSender}=mailgun`,
    );

    expect(map).toEqual({});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('unknown provider "mailgun"');
  });

  test("an unknown template id is an issue", () => {
    const { issues } = parseSendProviders("not-a-template=resend");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('unknown template id "not-a-template"');
  });

  test("malformed segments and duplicates are issues, all reported together", () => {
    const { issues } = parseSendProviders(
      `${TEMPLATE_IDS.fppSender},=resend,${TEMPLATE_IDS.fppSender}=,${TEMPLATE_IDS.fppReceiver}=resend,${TEMPLATE_IDS.fppReceiver}=resend`,
    );

    expect(issues).toHaveLength(4);
    expect(issues[3]).toContain("duplicate");
  });
});

describe("resolveSendProviderName", () => {
  test("a listed template resolves to its provider", () => {
    expect(
      resolveSendProviderName(TEMPLATE_IDS.fppSender, {
        [TEMPLATE_IDS.fppSender]: "resend",
      }),
    ).toBe("resend");
  });

  test("an unlisted or missing template id falls back to resend", () => {
    expect(resolveSendProviderName(TEMPLATE_IDS.fppReceiver, {})).toBe(
      "resend",
    );
    expect(resolveSendProviderName(undefined, {})).toBe("resend");
  });

  test("an Object.prototype key is not mistaken for a listing", () => {
    expect(resolveSendProviderName("toString", {})).toBe("resend");
  });
});

describe("sesConfigured", () => {
  const full = {
    SES_REGION: "eu-central-1",
    SES_ACCESS_KEY_ID: "id",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_CONFIGURATION_SET: "events",
  };

  test("needs region, both keys and the configuration set", () => {
    expect(sesConfigured(full)).toBe(true);
    expect(sesConfigured({})).toBe(false);
    for (const key of Object.keys(full)) {
      expect(sesConfigured({ ...full, [key]: undefined })).toBe(false);
    }
  });
});
