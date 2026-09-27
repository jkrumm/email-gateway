import { Elysia, t } from "elysia";
import { withBearerAuth } from "../auth";
import { env } from "../env";
import FppDailyAnalytics from "../emails/fpp/fpp-daily-analytics";
import FppReceiverMail from "../emails/fpp/fpp-receiver-mail";
import FppSenderMail from "../emails/fpp/fpp-sender-mail";
import { gateSubmission } from "../spam/gate";
import { sendMail } from "../utils/send-mail";

const fppContactBody = t.Object({
  name: t.Nullable(t.String()),
  email: t.String({ format: "email" }),
  subject: t.Nullable(t.String()),
  message: t.Nullable(t.String()),
});

const fppDailyAnalyticsBody = t.Object({
  votes: t.Number(),
  estimations: t.Number(),
  rooms: t.Number(),
  unique_users: t.Number(),
  page_views: t.Number(),
});

export const fppRoutes = withBearerAuth(new Elysia())
  .post(
    "/fpp",
    async ({ body }) => {
      await gateSubmission({
        source: "fpp",
        submission: body,
        deliver: async ({ subjectPrefix }) => {
          await sendMail({
            to: body.email,
            subject: "Free-Planning-Poker.com - Contact Form Submission",
            template: FppSenderMail(body),
            source: "fpp-sender",
          }).catch(() => ({}));

          await sendMail({
            to: env.RECEIVER_EMAIL,
            replyTo: `${body.name} <${body.email}>`,
            subject: `${subjectPrefix}Free-Planning-Poker.com - Contact Form Submission`,
            template: FppReceiverMail(body),
            source: "fpp-receiver",
          });
        },
      });

      return { message: "FPP contact emails sent successfully" };
    },
    { body: fppContactBody },
  )
  .post(
    "/fpp-daily-analytics",
    async ({ body }) => {
      await sendMail({
        to: env.RECEIVER_EMAIL,
        subject: "Free-Planning-Poker.com - Daily Analytics",
        template: FppDailyAnalytics(body),
        source: "fpp-daily-analytics",
      });

      console.log("Daily analytic emails sent successfully", body);
      return { message: "Daily analytic emails sent successfully" };
    },
    { body: fppDailyAnalyticsBody },
  );
