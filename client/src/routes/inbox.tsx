import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Badge, Loader, Stack, Table, Text } from "@mantine/core";
import { createLocalStore, PageBar } from "basalt-ui";
import { FilterSet, SelectFilter, ToggleFilter } from "basalt-ui/controls";
import { field } from "basalt-ui/state";
import { listAccounts, listMessages } from "../lib/api";
import { formatDate } from "../lib/format";
import { compareMessages, isUnread, messageRowView } from "../lib/messages";
import { DataTable } from "../components/DataTable";

export const Route = createFileRoute("/inbox")({ component: InboxPage });

const CATEGORIES = [
  "all",
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
] as const;

const PRIORITIES = ["all", "high", "medium", "low"] as const;

const inboxStore = createLocalStore({
  key: "email-gateway:inbox",
  fields: {
    needsMe: field.boolean(false),
    unreadOnly: field.boolean(false),
    category: field.enum(CATEGORIES, "all"),
    priority: field.enum(PRIORITIES, "all"),
    account: field.string(),
  },
}).labels({
  category: { all: "All" },
  priority: { all: "All" },
});

function InboxPage() {
  const [needsMe] = inboxStore.field.needsMe.use();
  const [unreadOnly] = inboxStore.field.unreadOnly.use();
  const [category] = inboxStore.field.category.use();
  const [priority] = inboxStore.field.priority.use();
  const [account] = inboxStore.field.account.use();

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
  });

  const messagesQuery = useQuery({
    queryKey: ["messages", { needsMe, category, account }],
    queryFn: () =>
      listMessages({
        needs_me: needsMe ? "1" : undefined,
        category: category === "all" ? undefined : category,
        account: account || undefined,
        limit: 100,
      }),
  });

  const rows = useMemo(() => {
    const all = messagesQuery.data?.rows ?? [];
    return all
      .filter((message) => (unreadOnly ? isUnread(message) : true))
      .filter((message) =>
        priority === "all"
          ? true
          : message.classification?.priority === priority,
      )
      .sort(compareMessages);
  }, [messagesQuery.data, unreadOnly, priority]);

  const accountOptions = [
    { value: "", label: "All" },
    ...(accountsQuery.data?.map((entry) => ({
      value: entry.id,
      label: `${entry.provider} · ${entry.address}`,
    })) ?? []),
  ];

  return (
    <Stack>
      <PageBar
        title="Inbox"
        filters={
          <FilterSet>
            <ToggleFilter field={inboxStore.field.needsMe} label="Needs me" />
            <ToggleFilter
              field={inboxStore.field.unreadOnly}
              label="Unread only"
            />
            <SelectFilter
              field={inboxStore.field.category}
              label="Category"
              clearable
            />
            <SelectFilter
              field={inboxStore.field.priority}
              label="Priority"
              clearable
            />
            <SelectFilter
              field={inboxStore.field.account}
              label="Account"
              options={accountOptions}
              clearable
            />
          </FilterSet>
        }
      />

      <Text size="sm" c="dimmed">
        {rows.length} message{rows.length === 1 ? "" : "s"}
      </Text>

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
