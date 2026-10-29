import { Text } from "react-email";
import AthenaLayout, {
  athenaColors as c,
  athenaFonts,
} from "../../layouts/athena.layout";

export const ATHENA_CODE_KINDS = ["sign-in"] as const;

export type AthenaCodeKind = (typeof ATHENA_CODE_KINDS)[number];

export interface AthenaCodeProps {
  kind: AthenaCodeKind;
  code: string;
  expiresInMinutes: number;
}

// "482915" -> "482 915": the form people read aloud and the subject shows.
export function athenaCodeDisplay(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function athenaCodeSubject(code: string): string {
  return `Your Athena code: ${athenaCodeDisplay(code)}`;
}

// Everything in a rendered mail that spells the code: the stored copy must
// replace each of them (the registry's `redact`).
export function athenaCodeSecrets(code: string): string[] {
  return [code, athenaCodeDisplay(code)];
}

export default function AthenaCodeMail({
  code,
  expiresInMinutes,
}: AthenaCodeProps) {
  const noteStyle = {
    fontSize: "14px",
    lineHeight: "22px",
    color: c.muted,
    margin: "0 0 8px",
  };

  return (
    <AthenaLayout preview={athenaCodeSubject(code)}>
      <Text
        className="at-body"
        style={{
          fontSize: "16px",
          lineHeight: "24px",
          color: c.body,
          margin: "0 0 16px",
        }}
      >
        {`Use this code to sign in to Athena. It expires in ${expiresInMinutes} minutes.`}
      </Text>
      <Text
        className="at-code at-ink"
        style={{
          display: "inline-block",
          fontFamily: athenaFonts.mono,
          fontSize: "28px",
          lineHeight: "36px",
          fontWeight: 600,
          letterSpacing: "4px",
          color: c.ink,
          backgroundColor: c.wash,
          border: `1px solid ${c.border}`,
          borderRadius: "6px",
          padding: "12px 20px",
          margin: "0 0 24px",
        }}
      >
        {athenaCodeDisplay(code)}
      </Text>
      <Text className="at-muted" style={noteStyle}>
        Sent by Johannes Krumm&apos;s Athena for team Athena, because someone
        asked to sign in with this address.
      </Text>
      <Text className="at-muted" style={noteStyle}>
        If you did not ask for this, ignore it.
      </Text>
    </AthenaLayout>
  );
}

AthenaCodeMail.PreviewProps = {
  kind: "sign-in",
  code: "482915",
  expiresInMinutes: 10,
} satisfies AthenaCodeProps;
