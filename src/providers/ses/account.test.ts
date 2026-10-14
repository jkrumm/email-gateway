import { GetAccountCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, test } from "bun:test";
import { fetchSesAccount, toSesAccountSnapshot } from "./account";

const fetchedAt = new Date("2026-10-14T10:00:00.000Z");

describe("toSesAccountSnapshot", () => {
  test("maps GetAccount's response", () => {
    expect(
      toSesAccountSnapshot(
        {
          SendingEnabled: true,
          EnforcementStatus: "HEALTHY",
          ProductionAccessEnabled: true,
          SendQuota: {
            Max24HourSend: 50000,
            MaxSendRate: 14,
            SentLast24Hours: 12,
          },
        },
        fetchedAt,
      ),
    ).toEqual({
      sendingEnabled: true,
      enforcementStatus: "HEALTHY",
      productionAccess: true,
      max24HourSend: 50000,
      maxSendRate: 14,
      sentLast24Hours: 12,
      fetchedAt: "2026-10-14T10:00:00.000Z",
    });
  });

  test("a sparse response maps to the safe defaults", () => {
    expect(toSesAccountSnapshot({}, fetchedAt)).toEqual({
      sendingEnabled: false,
      enforcementStatus: null,
      productionAccess: false,
      max24HourSend: null,
      maxSendRate: null,
      sentLast24Hours: null,
      fetchedAt: "2026-10-14T10:00:00.000Z",
    });
  });
});

describe("fetchSesAccount", () => {
  test("sends GetAccountCommand and maps the response", async () => {
    const commands: unknown[] = [];
    const snapshot = await fetchSesAccount({
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { SendingEnabled: true };
        },
      } as never,
      now: () => fetchedAt,
    });

    expect(commands[0]).toBeInstanceOf(GetAccountCommand);
    expect(snapshot.sendingEnabled).toBe(true);
    expect(snapshot.fetchedAt).toBe("2026-10-14T10:00:00.000Z");
  });

  test("propagates a client failure", async () => {
    await expect(
      fetchSesAccount({
        client: {
          send: async () => {
            throw new Error("AccessDenied");
          },
        } as never,
      }),
    ).rejects.toThrow("AccessDenied");
  });
});
