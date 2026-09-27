import { Elysia, t } from "elysia";
import { withBearerAuth } from "../auth";
import { env } from "../env";
import SySerendipityRequestMail from "../emails/sy-serendipity/request-receiver-mail";
import { gateSubmission } from "../spam/gate";
import { sendMail } from "../utils/send-mail";

const sySerendipityRequestBody = t.Object({
  firstName: t.Nullable(t.String({ maxLength: 200 })),
  lastName: t.Nullable(t.String({ maxLength: 200 })),
  email: t.String({ format: "email" }),
  numberOfPeople: t.Nullable(t.String({ maxLength: 200 })),
  destination: t.Nullable(t.String({ maxLength: 200 })),
  duration: t.Nullable(t.String({ maxLength: 200 })),
  arrivalDate: t.Nullable(t.String({ maxLength: 200 })),
  departureDate: t.Nullable(t.String({ maxLength: 200 })),
  phone: t.Nullable(t.String({ maxLength: 200 })),
  message: t.Nullable(t.String({ maxLength: 2000 })),
});

export const sySerendipityRoutes = withBearerAuth(new Elysia()).post(
  "/sy-serendipity",
  async ({ body }) => {
    const replyToName = [body.firstName, body.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    await gateSubmission({
      source: "sy-serendipity",
      submission: body,
      deliver: async ({ subjectPrefix }) => {
        await sendMail({
          to: env.SY_SERENDIPITY_RECEIVER_EMAIL,
          from: env.SY_SERENDIPITY_FROM_EMAIL,
          replyTo: replyToName ? `${replyToName} <${body.email}>` : body.email,
          subject: `${subjectPrefix}SY Serendipity I - Charter Request`,
          template: SySerendipityRequestMail(body),
          source: "sy-serendipity-request",
        });
      },
    });

    return { message: "SY Serendipity request email sent successfully" };
  },
  { body: sySerendipityRequestBody },
);
