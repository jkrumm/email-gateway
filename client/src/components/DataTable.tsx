import type { ReactNode } from "react";
import { Table, Text } from "@mantine/core";

interface DataTableProps {
  headers: readonly string[];
  emptyText: string;
  isEmpty: boolean;
  children: ReactNode;
}

export function DataTable({
  headers,
  emptyText,
  isEmpty,
  children,
}: DataTableProps) {
  if (isEmpty) return <Text c="dimmed">{emptyText}</Text>;
  return (
    <Table highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          {headers.map((header) => (
            <Table.Th key={header}>{header}</Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>{children}</Table.Tbody>
    </Table>
  );
}
