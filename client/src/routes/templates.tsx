import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, Group, Loader, Table, Text, Title } from "@mantine/core";
import { listTemplates } from "../lib/api";
import { formatDate } from "../lib/format";
import { DataTable } from "../components/DataTable";

export const Route = createFileRoute("/templates")({
  component: TemplatesPage,
});

function TemplatesPage() {
  const query = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplates,
  });

  if (query.isError)
    return <Alert color="red">Could not load templates.</Alert>;
  if (query.isLoading) return <Loader />;

  const rows = query.data ?? [];

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Card padding="md" style={{ flex: 1, overflowX: "auto" }}>
        <Title order={3} mb="sm">
          Templates
        </Title>
        <DataTable
          isEmpty={rows.length === 0}
          emptyText="No templates registered."
          headers={["Name", "Template ID", "Last test send"]}
        >
          {rows.map((template) => (
            <Table.Tr key={template.id}>
              <Table.Td>
                <Link
                  to="/templates/$id"
                  params={{ id: template.id }}
                  style={{ fontWeight: 500 }}
                >
                  {template.name}
                </Link>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {template.id}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{formatDate(template.lastTestSendAt)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </DataTable>
      </Card>
    </Group>
  );
}
