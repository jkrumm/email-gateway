import { Heading, Text, Section, Button } from 'react-email'
import FppLayout from '../../layouts/fpp.layout'

export interface FppSenderMailProps {
  name: string | null
  email: string
  subject: string | null
  message: string | null
}

export default function FppSenderMail({ name, email, subject, message }: FppSenderMailProps) {
  return (
    <FppLayout>
      <Section>
        <Heading as="h2">Thanks for submitting our contact form!</Heading>
        <Text>We will answer your message as soon as possible.</Text>
        <Button
          href="https://free-planning-poker.com/?source=email"
          style={{
            marginTop: 20,
            marginBottom: 50,
            backgroundColor: '#1971C2',
            color: '#ffffff',
            padding: '15px 30px',
            borderRadius: 3,
            textDecoration: 'none',
            display: 'inline-block',
          }}
          target="_blank"
        >
          Go back to planning
        </Button>
      </Section>
      <Section>
        <Heading as="h2">Your submission</Heading>
      </Section>
      <Section>
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

FppSenderMail.PreviewProps = {
  name: 'John Doe',
  email: 'john.doe@gmail.com',
  subject: 'Hello World!',
  message: 'Hello, I am interested in your product',
} satisfies FppSenderMailProps
