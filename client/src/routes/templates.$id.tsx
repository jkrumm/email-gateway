import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { createLocalStore, WidgetHeader } from "basalt-ui";
import { ViewTabs } from "basalt-ui/controls";
import { field } from "basalt-ui/state";
import { listSendLog, listTemplates, testSendTemplate } from "../lib/api";
import { formatDate } from "../lib/format";
import { DataTable } from "../components/DataTable";
import type { SendLogEntry, Template } from "../lib/types";

export const Route = createFileRoute("/templates/$id")({
  component: TemplatePage,
});

function statusColor(status: string | null): string {
  if (status === "delivered") return "green";
  if (status === "bounced" || status === "complained") return "red";
  if (status === "sent") return "blue";
  return "gray";
}

// Memory lane: the preview width never needs to be linkable or survive a reload.
const previewStore = createLocalStore({
  key: "email-gateway:template-preview",
  fields: {
    width: field.enum(["375", "600"], "600", { persist: false }),
  },
});

function templatePreviewPath(id: string, width: string): string {
  return `/api/templates/${encodeURIComponent(id)}/preview?width=${encodeURIComponent(width)}`;
}

function TemplatePreviewCard({
  id,
  template,
  onTestSend,
  testSendPending,
  testSendError,
  testSendSucceeded,
}: {
  id: string;
  template: Template;
  onTestSend: () => void;
  testSendPending: boolean;
  testSendError: Error | null;
  testSendSucceeded: boolean;
}) {
  const [width] = previewStore.field.width.use();

  const previewUrl = templatePreviewPath(id, width);
  const previewQuery = useQuery({
    queryKey: ["template-preview", id, width],
    queryFn: async () => {
      // Fetched client-side (not a direct iframe src=) so the HTML can be
      // rendered via srcDoc with sandbox="" — same-origin-with-full-cookie
      // iframe privileges are exactly what messages.$key.tsx avoids for
      // untrusted mail bodies, and while today's preview props are static
      // registry data, there is no reason this endpoint should run with more
      // privilege than that pattern already established.
      const response = await fetch(previewUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`preview failed: ${response.status}`);
      return response.text();
    },
  });

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <WidgetHeader
          tier="widget"
          title={template.name}
          subtitle={template.id}
          actions={
            <ViewTabs field={previewStore.field.width} label="Preview width" />
          }
        />

        <Group gap="xs" align="center">
          <Button size="xs" loading={testSendPending} onClick={onTestSend}>
            Send test
          </Button>
          {testSendSucceeded ? (
            <Text size="sm" c="green">
              Test send queued.
            </Text>
          ) : null}
          {testSendError ? (
            <Text size="sm" c="red">
              Test send failed: {testSendError.message}
            </Text>
          ) : null}
          <Text size="sm" c="dimmed">
            Last test send: {formatDate(template.lastTestSendAt)}
          </Text>
        </Group>

        <Group justify="center">
          <PreviewFrame width={width} query={previewQuery} />
        </Group>

        <Group gap="xs">
          <a href={previewUrl} target="_blank" rel="noreferrer">
            Open raw HTML
          </a>
        </Group>

        <details>
          <summary>Preview props</summary>
          <Text component="pre" size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(template.previewProps, null, 2)}
          </Text>
        </details>
      </Stack>
    </Card>
  );
}

function PreviewFrame({
  width,
  query,
}: {
  width: string;
  query: UseQueryResult<string>;
}) {
  if (query.isLoading) return <Loader />;
  if (query.isError)
    return <Alert color="red">Could not load the preview.</Alert>;
  return (
    <iframe
      title="template preview"
      sandbox=""
      srcDoc={query.data}
      style={{
        width: Number(width),
        height: "70vh",
        border: "1px solid var(--mantine-color-default-border)",
      }}
    />
  );
}

function TemplateSendLogCard({
  rows,
  hasMore,
}: {
  rows: SendLogEntry[];
  hasMore: boolean;
}) {
  return (
    <Card withBorder padding="md" style={{ overflowX: "auto" }}>
      <Title order={4} mb="sm">
        Send log
      </Title>
      <DataTable
        isEmpty={rows.length === 0}
        emptyText="No sends recorded for this template."
        headers={["Sent", "Recipients", "Status", "Requested by"]}
      >
        {rows.map((entry) => (
          <Table.Tr key={entry.id}>
            <Table.Td>
              <Text size="sm">{formatDate(entry.createdAt)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{entry.recipients.join(", ") || "—"}</Text>
            </Table.Td>
            <Table.Td>
              <Badge variant="light" color={statusColor(entry.status)}>
                {entry.status ?? "queued"}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Badge variant="light">{entry.requestedBy}</Badge>
            </Table.Td>
          </Table.Tr>
        ))}
      </DataTable>
      {hasMore ? (
        <Text size="xs" c="dimmed" mt="xs">
          Showing the most recent {rows.length} sends — more are not shown.
        </Text>
      ) : null}
    </Card>
  );
}

function SendLogSection({
  query,
}: {
  query: UseQueryResult<{ data: SendLogEntry[]; nextCursor: string | null }>;
}) {
  if (query.isError)
    return <Alert color="red">Could not load the send log.</Alert>;
  if (query.isLoading) return <Loader />;
  return (
    <TemplateSendLogCard
      rows={query.data?.data ?? []}
      hasMore={query.data?.nextCursor != null}
    />
  );
}

function TemplatePage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplates,
  });

  const sendLogQuery = useQuery({
    queryKey: ["send-log", id],
    queryFn: () => listSendLog({ templateId: id }),
  });

  const testSendMutation = useMutation({
    mutationFn: () => testSendTemplate(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["templates"] }),
        queryClient.invalidateQueries({ queryKey: ["send-log", id] }),
      ]);
    },
  });

  if (templatesQuery.isError)
    return <Alert color="red">Could not load templates.</Alert>;
  if (templatesQuery.isLoading) return <Loader />;

  const template = templatesQuery.data?.find((entry) => entry.id === id);
  if (!template) return <Alert color="red">No template with id {id}.</Alert>;

  return (
    <Stack>
      <Group justify="space-between">
        <Button component={Link} to="/templates" variant="subtle" size="xs">
          ← Templates
        </Button>
      </Group>

      <TemplatePreviewCard
        id={id}
        template={template}
        onTestSend={() => testSendMutation.mutate()}
        testSendPending={testSendMutation.isPending}
        testSendError={testSendMutation.error as Error | null}
        testSendSucceeded={testSendMutation.isSuccess}
      />

      <SendLogSection query={sendLogQuery} />
    </Stack>
  );
}
