import { useState, type FormEvent } from "react";
import {
  Button,
  Card,
  Center,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { login } from "../lib/session";

export function LoginView() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Center h="100vh">
      <Card withBorder padding="lg" w={340}>
        <form onSubmit={handleSubmit}>
          <Stack>
            <Title order={3}>email-gateway</Title>
            <PasswordInput
              label="Password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoFocus
              required
            />
            {error ? (
              <Text c="red" size="sm">
                {error}
              </Text>
            ) : null}
            <Button type="submit" loading={submitting}>
              Sign in
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
