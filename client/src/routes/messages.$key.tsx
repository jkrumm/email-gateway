import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { getMessage, moveMessage, setFlags } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Classification, MessageDetail } from "../lib/types";

export const Route = createFileRoute("/messages/$key")({
  component: MessagePage,
});

function classificationRow(
  label: string,
  value: string | null | undefined,
): { label: string; value: string }[] {
  return value ? [{ label, value }] : [];
}

function classificationRows(
  classification: Classification | null,
): { label: string; value: string }[] {
  if (!classification) return [];
  return [
    ...classificationRow("Category", classification.category),
    ...classificationRow("Priority", classification.priority),
    {
      label: "Action required",
      value: classification.actionRequired ? "yes" : "no",
    },
    ...classificationRow("Summary", classification.summary),
    ...classificationRow("Suggested action", classification.suggestedAction),
    ...classificationRow("Language", classification.language),
  ];
}

function ClassificationPanel({
  classification,
}: {
  classification: Classification | null;
}) {
  const rows = classificationRows(classification);
  return (
    <Card padding="md">
      <Title order={4} mb="xs">
        Classification
      </Title>
      {rows.length === 0 ? (
        <Text c="dimmed" size="sm">
          Not classified yet.
        </Text>
      ) : (
        <Stack gap={4}>
          {rows.map((row) => (
            <Group key={row.label} gap="xs" align="flex-start">
              <Text size="sm" fw={600} w={130}>
                {row.label}
              </Text>
              <Text size="sm">{row.value}</Text>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function MessageActions({
  message,
  busy,
  onFlag,
  onMove,
}: {
  message: MessageDetail;
  busy: boolean;
  onFlag: (change: { add?: string[]; remove?: string[] }) => void;
  onMove: (toMailbox: string) => void;
}) {
  const isSeen = message.flags.includes("\\Seen");
  const isStarred = message.flags.includes("\\Flagged");
  return (
    <Group gap="xs" mt="xs">
      <Button
        size="xs"
        variant="default"
        disabled={busy}
        onClick={() =>
          onFlag(isSeen ? { remove: ["\\Seen"] } : { add: ["\\Seen"] })
        }
      >
        {isSeen ? "Mark unread" : "Mark read"}
      </Button>
      <Button
        size="xs"
        variant="default"
        disabled={busy}
        onClick={() =>
          onFlag(isStarred ? { remove: ["\\Flagged"] } : { add: ["\\Flagged"] })
        }
      >
        {isStarred ? "Unstar" : "Star"}
      </Button>
      <Button
        size="xs"
        variant="default"
        disabled={busy}
        onClick={() => onMove("Archive")}
      >
        Archive
      </Button>
      <Button
        size="xs"
        variant="default"
        disabled={busy}
        onClick={() => onMove("Spam")}
      >
        Spam
      </Button>
      <Button
        size="xs"
        variant="default"
        disabled={busy}
        onClick={() => onMove("Trash")}
      >
        Trash
      </Button>
    </Group>
  );
}

function MessageHeader({
  message,
  busy,
  onFlag,
  onMove,
}: {
  message: MessageDetail;
  busy: boolean;
  onFlag: (change: { add?: string[]; remove?: string[] }) => void;
  onMove: (toMailbox: string) => void;
}) {
  return (
    <Card padding="md">
      <Stack gap="xs">
        <Title order={3}>{message.subject ?? "(no subject)"}</Title>
        <Group gap="xs">
          <Text size="sm">{message.fromAddress ?? "—"}</Text>
          <Text size="sm" c="dimmed">
            {formatDate(message.date)}
          </Text>
          {message.locations.map((location) => (
            <Badge key={location.mailbox} variant="light">
              {location.mailbox}
            </Badge>
          ))}
        </Group>
        <Text size="sm" c="dimmed">
          To: {message.toAddresses.join(", ") || "—"}
        </Text>
        <MessageActions
          message={message}
          busy={busy}
          onFlag={onFlag}
          onMove={onMove}
        />
      </Stack>
    </Card>
  );
}

function MessageBody({ body }: { body: MessageDetail["body"] }) {
  const { html, text } = body ?? { html: null, text: null };
  return (
    <Card padding={0}>
      <Divider />
      {html ? (
        // Untrusted mail HTML: sandbox="" disables scripts, forms and
        // same-origin access so the iframe cannot reach the session cookie.
        <iframe
          title="message body"
          sandbox=""
          srcDoc={html}
          style={{ width: "100%", height: "60vh", border: "none" }}
        />
      ) : text ? (
        <Text
          component="pre"
          p="md"
          style={{ whiteSpace: "pre-wrap", margin: 0 }}
        >
          {text}
        </Text>
      ) : (
        <Text c="dimmed" p="md">
          No body cached yet. Reading a message fills the cache.
        </Text>
      )}
    </Card>
  );
}

function MessagePage() {
  const { key } = Route.useParams();
  const queryClient = useQueryClient();

  const messageQuery = useQuery({
    queryKey: ["message", key],
    queryFn: () => getMessage(key),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["message", key] });
    await queryClient.invalidateQueries({ queryKey: ["messages"] });
  };

  const flagMutation = useMutation({
    mutationFn: (change: { add?: string[]; remove?: string[] }) => {
      const message = messageQuery.data;
      if (!message) throw new Error("message not loaded");
      const mailbox = message.locations[0]?.mailbox;
      if (!mailbox) throw new Error("no mailbox location");
      return setFlags(key, mailbox, change);
    },
    onSuccess: invalidate,
  });

  const moveMutation = useMutation({
    mutationFn: (toMailbox: string) => {
      const message = messageQuery.data;
      if (!message) throw new Error("message not loaded");
      const mailbox = message.locations[0]?.mailbox;
      if (!mailbox) throw new Error("no mailbox location");
      return moveMessage(key, mailbox, toMailbox);
    },
    onSuccess: invalidate,
  });

  if (messageQuery.isError) {
    return <Alert color="red">Could not load this message.</Alert>;
  }
  if (messageQuery.isLoading || !messageQuery.data) {
    return <Loader />;
  }

  const message: MessageDetail = messageQuery.data;
  const busy = flagMutation.isPending || moveMutation.isPending;

  return (
    <Stack>
      <Group justify="space-between">
        <Button component={Link} to="/inbox" variant="subtle" size="xs">
          ← Inbox
        </Button>
      </Group>
      <MessageHeader
        message={message}
        busy={busy}
        onFlag={(change) => flagMutation.mutate(change)}
        onMove={(toMailbox) => moveMutation.mutate(toMailbox)}
      />
      <ClassificationPanel classification={message.classification} />
      <MessageBody body={message.body} />
    </Stack>
  );
}
