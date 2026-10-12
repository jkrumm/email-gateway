import { describe, expect, test } from "bun:test";
import { buildRequestSubject } from "./request-subject";

const base = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane.doe@example.com",
  numberOfPeople: "6",
  arrivalDate: "Sat Jun 12 2027",
  departureDate: "Sat Jun 19 2027",
};

describe("buildRequestSubject", () => {
  test("full data", () => {
    expect(buildRequestSubject(base)).toBe(
      "Charter request: Jane Doe · 6 guests · 12–19 Jun 2027",
    );
  });

  test("ISO dates", () => {
    expect(
      buildRequestSubject({
        ...base,
        arrivalDate: "2027-06-12",
        departureDate: "2027-06-19",
      }),
    ).toBe("Charter request: Jane Doe · 6 guests · 12–19 Jun 2027");
  });

  test("single guest", () => {
    expect(buildRequestSubject({ ...base, numberOfPeople: "1" })).toBe(
      "Charter request: Jane Doe · 1 guest · 12–19 Jun 2027",
    );
  });

  test("missing name falls back to the email", () => {
    expect(
      buildRequestSubject({ ...base, firstName: null, lastName: null }),
    ).toBe("Charter request: jane.doe@example.com · 6 guests · 12–19 Jun 2027");
  });

  test("first name only", () => {
    expect(buildRequestSubject({ ...base, lastName: null })).toBe(
      "Charter request: Jane · 6 guests · 12–19 Jun 2027",
    );
  });

  test("non-numeric guests are omitted", () => {
    expect(buildRequestSubject({ ...base, numberOfPeople: "about 6" })).toBe(
      "Charter request: Jane Doe · 12–19 Jun 2027",
    );
    expect(buildRequestSubject({ ...base, numberOfPeople: null })).toBe(
      "Charter request: Jane Doe · 12–19 Jun 2027",
    );
  });

  test("cross-month range", () => {
    expect(
      buildRequestSubject({
        ...base,
        arrivalDate: "Mon Jun 28 2027",
        departureDate: "Sat Jul 03 2027",
      }),
    ).toBe("Charter request: Jane Doe · 6 guests · 28 Jun – 3 Jul 2027");
  });

  test("cross-year range", () => {
    expect(
      buildRequestSubject({
        ...base,
        arrivalDate: "Tue Dec 28 2027",
        departureDate: "Tue Jan 04 2028",
      }),
    ).toBe("Charter request: Jane Doe · 6 guests · 28 Dec 2027 – 4 Jan 2028");
  });

  test("same-day range collapses to one date", () => {
    expect(
      buildRequestSubject({ ...base, departureDate: "Sat Jun 12 2027" }),
    ).toBe("Charter request: Jane Doe · 6 guests · 12 Jun 2027");
  });

  test("missing or invalid dates are omitted", () => {
    const expected = "Charter request: Jane Doe · 6 guests";
    expect(buildRequestSubject({ ...base, departureDate: null })).toBe(
      expected,
    );
    expect(buildRequestSubject({ ...base, arrivalDate: null })).toBe(expected);
    expect(buildRequestSubject({ ...base, arrivalDate: "next summer" })).toBe(
      expected,
    );
    expect(buildRequestSubject({ ...base, departureDate: "2027-02-31" })).toBe(
      expected,
    );
    expect(
      buildRequestSubject({ ...base, arrivalDate: "Sat Foo 12 2027" }),
    ).toBe(expected);
  });

  test("nothing but the email", () => {
    expect(
      buildRequestSubject({
        firstName: null,
        lastName: null,
        email: "a@example.com",
        numberOfPeople: null,
        arrivalDate: null,
        departureDate: null,
      }),
    ).toBe("Charter request: a@example.com");
  });
});
