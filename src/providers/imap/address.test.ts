import { describe, expect, test } from "bun:test";
import { addressList } from "./address";

describe("addressList", () => {
  test("drops entries with a missing or empty address, keeps the rest", () => {
    expect(
      addressList([
        { address: "a@x.com" },
        { address: undefined },
        {},
        { address: "" },
        { address: "b@x.com" },
      ]),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  test("undefined input is an empty list, not a throw", () => {
    expect(addressList(undefined)).toEqual([]);
  });
});
