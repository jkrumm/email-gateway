import { describe, expect, test } from "bun:test";
import { render } from "@react-email/render";
import SySerendipityRequestMail from "./request-receiver-mail";

const props = SySerendipityRequestMail.PreviewProps;

async function html(overrides: Partial<typeof props>) {
  return render(<SySerendipityRequestMail {...props} {...overrides} />);
}

describe("SySerendipityRequestMail dates", () => {
  test("toDateString values render as long dates and in the preview text", async () => {
    const out = await html({
      arrivalDate: "Sat Jun 12 2027",
      departureDate: "Sat Jun 19 2027",
    });
    expect(out).toContain("12 June 2027");
    expect(out).toContain("19 June 2027");
    expect(out).toContain("12–19 Jun 2027");
  });

  test("ISO values render the same way", async () => {
    const out = await html({
      arrivalDate: "2027-06-12",
      departureDate: "2027-06-19",
    });
    expect(out).toContain("12 June 2027");
    expect(out).toContain("12–19 Jun 2027");
  });

  test("unparseable values fall back to the raw string", async () => {
    const out = await html({
      arrivalDate: "next summer",
      departureDate: "Sat Foo 12 2027",
    });
    expect(out).toContain("next summer");
    expect(out).toContain("Sat Foo 12 2027");
  });
});
