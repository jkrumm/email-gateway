import { Elysia, t } from "elysia";
import { withBearerAuth } from "../auth";
import { env } from "../env";
import SySerendipityConfirmationMail from "../emails/sy-serendipity/request-confirmation-mail";
import SySerendipityRequestMail from "../emails/sy-serendipity/request-receiver-mail";
import { TEMPLATE_IDS } from "../emails/registry";
import { gateSubmission } from "../spam/gate";
import { buildRequestSubject } from "../emails/sy-serendipity/request-subject";
import { sendMail } from "../utils/send-mail";
import { log } from "../telemetry/log";

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

export function createSySerendipityRoutes({
  gate = gateSubmission,
  send = sendMail,
}: {
  gate?: typeof gateSubmission;
  send?: typeof sendMail;
} = {}) {
  return withBearerAuth(new Elysia()).post(
    "/sy-serendipity",
    async ({ body }) => {
      const receivedAt = new Date();
      const replyToName = [body.firstName, body.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();

      await gate({
        source: "sy-serendipity",
        submission: body,
        deliver: async ({ subjectPrefix }) => {
          await send({
            to: env.SY_SERENDIPITY_RECEIVER_EMAIL,
            from: env.SY_SERENDIPITY_FROM_EMAIL,
            replyTo: replyToName
              ? `${replyToName} <${body.email}>`
              : body.email,
            subject: `${subjectPrefix}${buildRequestSubject(body)}`,
            template: SySerendipityRequestMail({ ...body, receivedAt }),
            source: TEMPLATE_IDS.sySerendipityRequest,
          });

          // The requester's receipt, after the receiver copy is out and never
          // for a held submission (deliver only runs when the gate delivers).
          // Fail open like fppSender: the sandbox rejects unverified recipients.
          await send({
            to: body.email,
            from: env.SY_SERENDIPITY_FROM_EMAIL,
            subject: "Your charter request – Serendipity I",
            template: SySerendipityConfirmationMail({
              firstName: body.firstName,
            }),
            source: TEMPLATE_IDS.sySerendipityConfirmation,
          }).catch((error) => {
            log.error("SY Serendipity confirmation failed", { error });
          });
        },
      });

      return { message: "SY Serendipity request email sent successfully" };
    },
    { body: sySerendipityRequestBody },
  );
}

export const sySerendipityRoutes = createSySerendipityRoutes();
