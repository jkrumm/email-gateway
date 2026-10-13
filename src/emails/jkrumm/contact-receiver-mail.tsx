import { Heading, Text, Section } from "react-email";
import FppLayout from "../../layouts/fpp.layout";

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
  return (
    <FppLayout>
      <Section>
        <Heading as="h2">New message from jkrumm.com</Heading>
        <Text>Someone used the contact form on the personal site.</Text>
      </Section>
      <Section
        style={{
          marginTop: 30,
        }}
      >
        <Heading as="h3">Name</Heading>
        <Text>{name}</Text>
      </Section>
      <Section>
        <Heading as="h3">Email</Heading>
        <Text>{email}</Text>
      </Section>
      <Section>
        <Heading as="h3">Message</Heading>
        <Text style={{ whiteSpace: "pre-wrap" }}>{message}</Text>
      </Section>
    </FppLayout>
  );
}

JkrummContactReceiverMail.PreviewProps = {
  name: "John Doe",
  email: "john.doe@gmail.com",
  message: "Hi Johannes, I liked your talk and would like to get in touch.",
} satisfies JkrummContactReceiverProps;
