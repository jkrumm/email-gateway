import { describe, expect, test } from "bun:test";
import { mapSesEvent } from "./events";

const mail = { messageId: "ses-msg-1" };

describe("mapSesEvent", () => {
  test.each([
    ["Delivery", "delivered"],
    ["Complaint", "complained"],
    ["Reject", "rejected"],
    ["DeliveryDelay", "delivery_delayed"],
    ["Rendering Failure", "failed"],
  ])("%s -> %s", (eventType, status) => {
    expect(mapSesEvent({ eventType, mail })).toEqual({
      providerMessageId: "ses-msg-1",
      status,
      lastEvent: status,
    });
  });

  test("Bounce -> bounced, with the bounce type in lastEvent", () => {
    for (const bounceType of ["Permanent", "Transient", "Undetermined"]) {
      expect(
        mapSesEvent({ eventType: "Bounce", mail, bounce: { bounceType } }),
      ).toEqual({
        providerMessageId: "ses-msg-1",
        status: "bounced",
        lastEvent: `bounced:${bounceType}`,
      });
    }
  });

  test("a Bounce without a type is still bounced", () => {
    expect(mapSesEvent({ eventType: "Bounce", mail })).toEqual({
      providerMessageId: "ses-msg-1",
      status: "bounced",
      lastEvent: "bounced",
    });
  });

  test("Send, Open, Click, Subscription and unknown types are ignored", () => {
    for (const eventType of [
      "Send",
      "Open",
      "Click",
      "Subscription",
      "Something New",
      "toString",
    ]) {
      expect(mapSesEvent({ eventType, mail })).toBeNull();
    }
  });

  test("malformed payloads are ignored", () => {
    for (const payload of [
      null,
      "Delivery",
      [],
      {},
      { eventType: "Delivery" },
      { eventType: "Delivery", mail: {} },
      { eventType: "Delivery", mail: { messageId: "" } },
      { eventType: 7, mail },
    ]) {
      expect(mapSesEvent(payload)).toBeNull();
    }
  });
});
