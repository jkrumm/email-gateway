import { Heading, Text, Section } from 'react-email'
import FppLayout from '../../layouts/fpp.layout'

export interface FppReceiverProps {
  name: string | null
  email: string
  subject: string | null
  message: string | null
}

export default function FppReceiverMail({ name, email, subject, message }: FppReceiverProps) {
  return (
    <FppLayout>
      <Section>
        <Heading as="h2">New form submission! 🎉</Heading>
        <Text>We have received a contact form submission.</Text>
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
        <Heading as="h3">Subject</Heading>
        <Text>{subject}</Text>
      </Section>
      <Section>
        <Heading as="h3">Message</Heading>
        <Text>{message}</Text>
      </Section>
    </FppLayout>
  )
}

FppReceiverMail.PreviewProps = {
  name: 'John Doe',
  email: 'john.doe@gmail.com',
  subject: 'Hello World!',
  message: 'Hello, I am interested in your product',
} satisfies FppReceiverProps
