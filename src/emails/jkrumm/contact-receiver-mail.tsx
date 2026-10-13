import { Heading, Section, Text } from "react-email";
import JkrummLayout, {
  jkrummColors,
  jkrummFonts,
} from "../../layouts/jkrumm.layout";

export interface JkrummContactReceiverProps {
  name: string | null;
  email: string;
  message: string;
}

export default function JkrummContactReceiverMail({
  name,
  email,
  message,
}: JkrummContactReceiverProps) {
  const sender = name ?? "Someone";

  return (
    <JkrummLayout preview={`New message from ${sender} via jkrumm.com`}>
      <Section>
        <Heading
          as="h1"
          style={{
            fontSize: "22px",
            lineHeight: "1.25",
            letterSpacing: "-0.02em",
            fontWeight: 600,
            margin: "0 0 12px",
          }}
        >
          New message from jkrumm.com
        </Heading>
        <Text style={{ fontWeight: 600, margin: 0 }}>
          {name ?? "No name given"}
        </Text>
        <Text
          style={{ fontFamily: jkrummFonts.mono, fontSize: "14px", margin: 0 }}
        >
          {email}
        </Text>
      </Section>

      <Section
        style={{
          backgroundColor: jkrummColors.panel,
          borderLeft: `3px solid ${jkrummColors.accent}`,
          borderRadius: "4px",
          padding: "4px 20px",
          margin: "24px 0 0",
        }}
      >
        <Text style={{ whiteSpace: "pre-wrap", margin: "12px 0" }}>
          {message}
        </Text>
      </Section>

      <Text
        style={{
          fontSize: "13px",
          color: jkrummColors.muted,
          margin: "20px 0 0",
        }}
      >
        Reply to this mail to answer {sender} directly.
      </Text>
    </JkrummLayout>
  );
}

JkrummContactReceiverMail.PreviewProps = {
  name: "John Doe",
  email: "john.doe@gmail.com",
  message: "Hi Johannes, I liked your talk and would like to get in touch.",
} satisfies JkrummContactReceiverProps;
