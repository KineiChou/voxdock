import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router-dom";
import type { ConsoleCallSummary } from "../../../packages/contracts/src/console";
export const label = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const seconds = (value: number | null) =>
  value === null
    ? "Unknown"
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant="light"
      color={
        ["connected", "ready", "completed", "settled"].includes(value)
          ? "teal"
          : ["uncertain", "not_ready", "failed", "unknown"].includes(value)
            ? "orange"
            : "gray"
      }
    >
      {label(value)}
    </Badge>
  );
}
export function Loading() {
  return (
    <Center py={80}>
      <Loader size="sm" aria-label="Loading" />
    </Center>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  return (
    <Alert color="red" title="Unable to load">
      {error.message}
      {retry && (
        <Button variant="subtle" color="red" onClick={retry}>
          Try again
        </Button>
      )}
    </Alert>
  );
}
export function Empty({
  title = "No calls yet",
  text = "Calls will appear here when activity is recorded.",
}: {
  title?: string;
  text?: string;
}) {
  return (
    <Center py={48}>
      <Stack gap={6} align="center">
        <Text fw={600}>{title}</Text>
        <Text c="dimmed" size="sm" ta="center">
          {text}
        </Text>
      </Stack>
    </Center>
  );
}
export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" mb={28}>
      <div>
        <Text className="eyebrow" mb={7}>
          WORKSPACE / {title === "Call detail" ? "CALLS" : title.toUpperCase()}
        </Text>
        <Title order={1}>{title}</Title>
        <Text c="dimmed" size="sm" mt={7}>
          {description}
        </Text>
      </div>
      {action}
    </Group>
  );
}
export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder radius="lg" p="lg">
      <Group justify="space-between" mb="lg">
        <Title order={3}>{title}</Title>
        {aside}
      </Group>
      {children}
    </Paper>
  );
}
export function CallsTable({ calls }: { calls: ConsoleCallSummary[] }) {
  if (!calls.length) return <Empty />;
  return (
    <Table.ScrollContainer minWidth={690}>
      <Table verticalSpacing="md" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Call / target</Table.Th>
            <Table.Th>Channel</Table.Th>
            <Table.Th>Direction</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Duration</Table.Th>
            <Table.Th>Started</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {calls.map((item) => (
            <Table.Tr key={item.call.call_id}>
              <Table.Td>
                <Link
                  className="call-link"
                  to={`/calls/${encodeURIComponent(item.call.call_id)}`}
                >
                  {item.call.call_id}
                </Link>
                <Text size="xs" c="dimmed" mt={3}>
                  {item.call.target_id}
                </Text>
              </Table.Td>
              <Table.Td>{label(item.channel ?? "unknown")}</Table.Td>
              <Table.Td>{label(item.call.direction)}</Table.Td>
              <Table.Td>
                <Status value={item.call.state} />
              </Table.Td>
              <Table.Td>{seconds(item.duration_seconds)}</Table.Td>
              <Table.Td>{date(item.call.created_at)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
export function Fields({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="fields">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
