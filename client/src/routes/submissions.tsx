import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { listSubmissions } from "../lib/api";
import { formatDate } from "../lib/format";
import type { Submission } from "../lib/types";
import { DataTable } from "../components/DataTable";

export const Route = createFileRoute("/submissions")({
  component: SubmissionsPage,
});

function verdictColor(verdict: Submission["verdict"]): string {
  if (verdict === "legit") return "green";
  if (verdict === "spam") return "red";
  return "orange";
}

function messageOf(submission: Submission): string {
  const value = submission.submission.message;
  return typeof value === "string" ? value : "";
}

function SubmissionsPage() {
  const query = useQuery({
    queryKey: ["submissions"],
    queryFn: () => listSubmissions(),
  });

  if (query.isError)
    return <Alert color="red">Could not load submissions.</Alert>;
  if (query.isLoading) return <Loader />;

  const rows = query.data?.data ?? [];

  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Card padding="md" style={{ flex: 1, overflowX: "auto" }}>
        <Title order={3} mb="sm">
          Spam filter
        </Title>
        <DataTable
          isEmpty={rows.length === 0}
          emptyText="No submissions recorded."
          headers={[
            "Received",
            "Source",
            "Verdict",
            "Confidence",
            "Delivered",
            "Jev",
            "Message",
          ]}
        >
          {rows.map((submission) => (
            <Table.Tr key={submission.id}>
              <Table.Td>
                <Text size="sm">{formatDate(submission.receivedAt)}</Text>
              </Table.Td>
              <Table.Td>
                <Badge variant="light">{submission.source}</Badge>
              </Table.Td>
              <Table.Td>
                <Badge color={verdictColor(submission.verdict)}>
                  {submission.verdict}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {(submission.confidence * 100).toFixed(0)}%
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{submission.delivered ? "yes" : "no"}</Text>
              </Table.Td>
              <Table.Td>
                {submission.jev?.verdict ? (
                  <Badge
                    variant="light"
                    color={
                      submission.jev.verdict === submission.verdict
                        ? "green"
                        : "red"
                    }
                  >
                    {submission.jev.verdict}
                  </Badge>
                ) : (
                  <Text size="sm" c="dimmed">
                    not yet judged
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ maxWidth: 360 }}>
                <Text size="sm" lineClamp={3}>
                  {messageOf(submission) || submission.reason}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </DataTable>
      </Card>
    </Group>
  );
}
