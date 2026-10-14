import { Elysia, t } from "elysia";
import { extractBearerToken, timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import ShutterflowCodeMail, {
  SHUTTERFLOW_CODE_KINDS,
  shutterflowCodeSubject,
} from "../emails/shutterflow/code-mail";
import { TEMPLATE_IDS } from "../emails/registry";
import { sendMail } from "../utils/send-mail";

const shutterflowBody = t.Object({
  kind: t.Union(SHUTTERFLOW_CODE_KINDS.map((kind) => t.Literal(kind))),
  to: t.String({ format: "email", maxLength: 320 }),
  code: t.String({ pattern: "^[A-Za-z0-9]{4,16}$" }),
  expiresInMinutes: t.Integer({ minimum: 1, maximum: 1440 }),
});

// Own guard on a fresh instance, so SECRET_KEY opens nothing here. Unset key
// -> 404 like /api without API_KEY. No spam gate: a user is waiting for the
// code. The send is synchronous and a provider error is a 502, so Shutterflow
// can offer a retry. The code is never logged and never reaches send_log
// (`sensitiveSubject` redacts the subject, which leads with it).
export function createShutterflowRoutes({
  secretKey,
  fromEmail,
  send = sendMail,
}: {
  secretKey: string | undefined;
  fromEmail?: string | undefined;
  send?: typeof sendMail;
}) {
  return new Elysia()
    .onBeforeHandle(({ headers, set }) => {
      if (secretKey === undefined) {
        set.status = 404;
        return { message: "Not Found" };
      }

      const token = extractBearerToken(headers.authorization);
      if (token && timingSafeEqualStrings(token, secretKey)) return;

      set.status = 401;
      set.headers["WWW-Authenticate"] =
        `Bearer realm='shutterflow', error="invalid_token"`;
      return { message: "Unauthorized" };
    })
    .post(
      "/shutterflow",
      async ({ body, set }) => {
        try {
          await send({
            to: body.to,
            ...(fromEmail ? { from: fromEmail } : {}),
            subject: shutterflowCodeSubject(body.kind, body.code),
            template: ShutterflowCodeMail({
              kind: body.kind,
              code: body.code,
              expiresInMinutes: body.expiresInMinutes,
            }),
            source: TEMPLATE_IDS.shutterflowCode,
            sensitiveSubject: true,
          });
        } catch (error) {
          // Never the error object: a render failure could embed the props (the code).
          console.error("Shutterflow code send failed", {
            to: body.to,
            reason: error instanceof Error ? error.name : "unknown",
          });
          set.status = 502;
          return { message: "Send failed" };
        }
        return { message: "Code sent" };
      },
      { body: shutterflowBody },
    );
}

export const shutterflowRoutes = createShutterflowRoutes({
  secretKey: env.SHUTTERFLOW_SECRET_KEY,
  fromEmail: env.SHUTTERFLOW_FROM_EMAIL,
});
