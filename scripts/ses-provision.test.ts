import { describe, expect, test } from "bun:test";
import {
  EVENT_TYPES,
  SUPPRESSED_REASONS,
  dnsRecords,
  sendPolicy,
  suppressionArgs,
  topicPolicy,
} from "./ses-provision";

describe("ses-provision", () => {
  test("dnsRecords: three DKIM CNAMEs plus MAIL FROM MX and SPF on the ses. subdomain", () => {
    const recs = dnsRecords("example.com", ["a", "b", "c"]);
    expect(recs.filter((r) => r.type === "CNAME").map((r) => r.name)).toEqual([
      "a._domainkey.example.com",
      "b._domainkey.example.com",
      "c._domainkey.example.com",
    ]);
    expect(recs.find((r) => r.type === "MX")?.name).toBe("ses.example.com");
    expect(recs.find((r) => r.type === "TXT")?.value).toContain(
      "amazonses.com",
    );
  });

  test("sendPolicy scopes to this account's identities and the configuration set", () => {
    const p = sendPolicy("123") as any;
    expect(p.Statement[0].Resource).toEqual([
      "arn:aws:ses:eu-central-1:123:identity/*",
      "arn:aws:ses:eu-central-1:123:configuration-set/email-gateway",
    ]);
  });

  test("sendPolicy grants the account-level read/suppression actions on *", () => {
    const p = sendPolicy("123") as any;
    expect(p.Statement).toHaveLength(2);
    expect(p.Statement[1]).toEqual({
      Effect: "Allow",
      Action: [
        "ses:GetAccount",
        "ses:ListSuppressedDestinations",
        "ses:DeleteSuppressedDestination",
      ],
      Resource: "*",
    });
  });

  test("topicPolicy only lets SES of this account's configuration set publish", () => {
    const p = topicPolicy("arn:aws:sns:eu-central-1:123:t", "123") as any;
    expect(p.Statement[0].Principal.Service).toBe("ses.amazonaws.com");
    expect(p.Statement[0].Condition.StringEquals["AWS:SourceAccount"]).toBe(
      "123",
    );
  });

  test("EVENT_TYPES are exactly the SESv2 enum values, no tracking events", () => {
    expect([...EVENT_TYPES]).toEqual([
      "SEND",
      "DELIVERY",
      "BOUNCE",
      "COMPLAINT",
      "REJECT",
      "DELIVERY_DELAY",
      "RENDERING_FAILURE",
    ]);
  });

  test("suppressionArgs enables the account list for BOUNCE and COMPLAINT only", () => {
    expect([...SUPPRESSED_REASONS]).toEqual(["BOUNCE", "COMPLAINT"]);
    expect(suppressionArgs()).toEqual([
      "sesv2",
      "put-account-suppression-attributes",
      "--suppressed-reasons",
      "BOUNCE",
      "COMPLAINT",
    ]);
  });
});
