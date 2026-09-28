import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { listAccounts, listMessages } from "../lib/api";
import { formatDate } from "../lib/format";
import { compareMessages, isUnread, messageRowView } from "../lib/messages";
import { DataTable } from "../components/DataTable";

export const Route = createFileRoute("/inbox")({ component: InboxPage });

const CATEGORIES = [
  "inquiry",
  "customer",
  "support",
  "feedback",
  "invoice",
  "notification",
  "newsletter",
  "marketing",
  "spam",
  "personal",
  "other",
];

const PRIORITIES = ["high", "medium", "low"];

function InboxPage() {
  const [needsMe, setNeedsMe] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
  });

  const messagesQuery = useQuery({
    queryKey: ["messages", { needsMe, category, account }],
    queryFn: () =>
      listMessages({
        needs_me: needsMe ? "1" : undefined,
        category: category ?? undefined,
        account: account ?? undefined,
        limit: 100,
      }),
  });

  const rows = useMemo(() => {
    const all = messagesQuery.data?.rows ?? [];
    return all
      .filter((message) => (unreadOnly ? isUnread(message) : true))
      .filter((message) =>
        priority ? message.classification?.priority === priority : true,
      )
      .sort(compareMessages);
  }, [messagesQuery.data, unreadOnly, priority]);

  const accountOptions =
    accountsQuery.data?.map((entry) => ({
      value: entry.id,
      label: `${entry.provider} · ${entry.address}`,
    })) ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Inbox</Title>
        <Text size="sm" c="dimmed">
          {rows.length} message{rows.length === 1 ? "" : "s"}
        </Text>
      </Group>

      <Card withBorder padding="md">
        <Group align="flex-end" gap="md">
          <Switch
            label="Needs me"
            checked={needsMe}
            onChange={(event) => setNeedsMe(event.currentTarget.checked)}
          />
          <Switch
            label="Unread only"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.currentTarget.checked)}
          />
          <Select
            label="Category"
            placeholder="All"
            clearable
            data={CATEGORIES}
            value={category}
            onChange={setCategory}
            w={180}
          />
          <Select
            label="Priority"
            placeholder="All"
            clearable
            data={PRIORITIES}
            value={priority}
            onChange={setPriority}
            w={140}
          />
          <Select
            label="Account"
            placeholder="All"
            clearable
            data={accountOptions}
            value={account}
            onChange={setAccount}
            w={260}
          />
        </Group>
      </Card>

      {messagesQuery.isError ? (
        <Alert color="red">Could not load messages.</Alert>
      ) : messagesQuery.isLoading ? (
        <Loader />
      ) : (
        <DataTable
          isEmpty={rows.length === 0}
          emptyText="No messages match these filters."
          headers={["Account", "From", "Subject", "Category", "Date"]}
        >
          {rows.map((message) => {
            const view = messageRowView(message);
            return (
              <Table.Tr key={message.key}>
                <Table.Td>
                  <Badge variant="light">{view.provider}</Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{view.from}</Text>
                  {view.unread ? (
                    <Badge size="xs" color="blue" variant="dot">
                      unread
                    </Badge>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Link
                    to="/messages/$key"
                    params={{ key: message.key }}
                    style={{ fontWeight: 500 }}
                  >
                    {view.subject}
                  </Link>
                  {view.actionRequired ? (
                    <Badge size="xs" color="orange" ml="xs">
                      action
                    </Badge>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  {view.category ? (
                    <Badge variant="light">{view.category}</Badge>
                  ) : (
                    <Text size="sm" c="dimmed">
                      unclassified
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{formatDate(message.date)}</Text>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </DataTable>
      )}
    </Stack>
  );
}
