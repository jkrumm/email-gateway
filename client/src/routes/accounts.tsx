import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { PageBar } from "basalt-ui";
import { CONTAINER_KEYS, VX } from "basalt-ui/tokens";
import { getStats, listAccounts } from "../lib/api";
import { formatDate } from "../lib/format";

export const Route = createFileRoute("/accounts")({ component: AccountsPage });

function AccountsPage() {
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
  });
  const statsQuery = useQuery({ queryKey: ["stats"], queryFn: getStats });

  if (accountsQuery.isError || statsQuery.isError) {
    return <Alert color="red">Could not load account health.</Alert>;
  }
  if (accountsQuery.isLoading || statsQuery.isLoading) return <Loader />;

  const accounts = accountsQuery.data ?? [];
  const stats = statsQuery.data;

  return (
    <Stack>
      <PageBar title="Accounts & health" />

      {stats ? (
        <SimpleGrid
          type="container"
          cols={{ base: 1, [CONTAINER_KEYS.regular]: 3 }}
        >
          <Card py="xs" px="sm">
            <Text size="sm" c="dimmed">
              Messages (30d)
            </Text>
            <Text fz={VX.text.kpi} fw={600}>
              {stats.messages.total}
            </Text>
            <Text size="xs" c="dimmed">
              {stats.messages.inbound} in / {stats.messages.outbound} out
            </Text>
          </Card>
          <Card py="xs" px="sm">
            <Text size="sm" c="dimmed">
              Jobs pending
            </Text>
            <Text fz={VX.text.kpi} fw={600}>
              {stats.jobs.pending}
            </Text>
            <Text size="xs" c="dimmed">
              {stats.jobs.failed} failed
            </Text>
          </Card>
          <Card py="xs" px="sm">
            <Text size="sm" c="dimmed">
              Accounts
            </Text>
            <Text fz={VX.text.kpi} fw={600}>
              {accounts.length}
            </Text>
          </Card>
        </SimpleGrid>
      ) : null}

      <Card py="xs" px="sm">
        <Group justify="space-between" mb="sm">
          <Title order={4}>Configured accounts</Title>
        </Group>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Provider</Table.Th>
              <Table.Th>Address</Table.Th>
              <Table.Th>Last success</Table.Th>
              <Table.Th>Last error</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {accounts.map((account) => {
              const stored = stats?.accounts.find(
                (entry) => entry.id === account.id,
              );
              return (
                <Table.Tr key={account.id}>
                  <Table.Td>
                    <Badge variant="light">{account.provider}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{account.address}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {formatDate(stored?.lastSuccessAt ?? null)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {stored?.lastError ? (
                      <Text size="sm" c="red">
                        {stored.lastError}
                      </Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        none
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
