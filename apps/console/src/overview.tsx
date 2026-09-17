import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { BarChart, DonutChart } from "@mantine/charts";
import { IconArrowUpRight, IconPhone } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import type {
  ConsoleOverview,
  ConsoleSettings,
} from "../../../packages/contracts/src/console";
import { useResource } from "./api";
import {
  CallsTable,
  Failure,
  Fields,
  Loading,
  PageTitle,
  Panel,
  seconds,
  Status,
} from "./shared";
const activityYAxisWidth = 60;
const activityDateSpacing = 48;

export function Overview() {
  const [days, setDays] = useState("7");
  const overview = useResource<ConsoleOverview>(`/overview?days=${days}`);
  const settings = useResource<Pick<ConsoleSettings, 'calling'>>("/control/status");
  const data = overview.data;
  const { ref: chartRef, width: chartWidth } = useElementSize();
  // Share a numeric interval so grid and labels use the same unshifted date centers.
  const dateInterval = Math.max(
    0,
    Math.ceil(
      ((data?.daily.length ?? 1) * activityDateSpacing) /
        Math.max(chartWidth - activityYAxisWidth, activityDateSpacing),
    ) - 1,
  );
  return (
    <>
      <PageTitle
        title="Overview"
        description="A clear view of your calls, conversations, and delegated work."
        action={settings.data && <Status value={settings.data.calling.status} />}
      />
      <Group justify="space-between" mb="lg">
        <div>
          <Text fw={600}>Activity at a glance</Text>
          {data && <Text size="xs" c="dimmed">Updated {new Date(data.generated_at).toLocaleTimeString()}</Text>}
        </div>
        <SegmentedControl
          value={days}
          onChange={setDays}
          data={[
            { value: "1", label: "Today" },
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
          ]}
        />
      </Group>
      {settings.error && <Failure error={settings.error} />}
      {overview.isPending ? (
        <Loading />
      ) : overview.error ? (
        <Failure error={overview.error} retry={() => void overview.refetch()} />
      ) : (
        data && (
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }}>
              <Metric
                title="Total calls"
                value={data.totals.calls.toLocaleString()}
                note={`${data.totals.unknown_outcomes} unknown outcomes`}
              />
              <Metric
                title="Observed connection rate"
                value={
                  data.totals.connection_rate === null
                    ? "Unknown"
                    : `${(data.totals.connection_rate * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
                }
                note={`${data.totals.observed_calls} ended calls with a known outcome`}
              />
              <Metric
                title="Settled Live usage"
                value={seconds(data.totals.settled_live_seconds)}
                note={`${seconds(data.totals.reserved_live_seconds)} reserved · ${seconds(data.totals.unknown_live_seconds)} unknown`}
              />
              <Metric
                title="Delegations"
                value={data.totals.delegations.total.toLocaleString()}
                note={`${data.totals.delegations.completed} completed · ${data.totals.delegations.pending} pending · ${data.totals.delegations.failed} failed`}
              />
            </SimpleGrid>
            <div className="chart-grid">
              <Panel
                title="Call activity"
                aside={
                  <Text size="xs" c="dimmed">
                    {data.timezone}
                  </Text>
                }
              >
                <BarChart
                  ref={chartRef}
                  h={260}
                  data={data.daily}
                  dataKey="date"
                  series={[
                    { name: "calls", label: "All calls", color: "teal.3" },
                    {
                      name: "connected_calls",
                      label: "Connected",
                      color: "teal.8",
                    },
                  ]}
                  withLegend
                  tickLine="none"
                  gridAxis="y"
                  gridProps={{ syncWithTicks: true }}
                  xAxisProps={{
                    interval: dateInterval,
                    tickFormatter: (date: string) => date.slice(5),
                  }}
                  yAxisProps={{ allowDecimals: false, width: activityYAxisWidth }}
                />
              </Panel>
              <Panel title="By channel">
                <DonutChart
                  h={185}
                  size={170}
                  mx="auto"
                  data={data.channels.map((item) => ({
                    name: item.channel,
                    value: item.calls,
                    color:
                      item.channel === "telegram"
                        ? "teal.7"
                        : item.channel === "whatsapp"
                          ? "teal.3"
                          : "gray.4",
                  }))}
                  withLabelsLine={false}
                />
                <Stack gap={10} mt="lg">
                  {data.channels.map((item) => (
                    <Group justify="space-between" key={item.channel}>
                      <Text size="sm" tt="capitalize">
                        {item.channel}
                      </Text>
                      <Text size="sm" fw={600}>
                        {item.calls}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </Panel>
            </div>
            {data.attention_calls.length > 0 && (
              <Panel title="Needs review" aside={<Status value="uncertain" />}>
                <Alert color="orange" mb="sm">
                  These calls have an unresolved outcome. Open a call to review
                  its latest record.
                </Alert>
                <CallsTable calls={data.attention_calls} />
              </Panel>
            )}
            <Panel
              title="Current calls"
              aside={
                <IconPhone size={18} color="var(--mantine-color-teal-7)" />
              }
            >
              <CallsTable calls={data.active_calls} />
            </Panel>
            <Panel
              title="Recent calls"
              aside={
                <Button
                  component={Link}
                  to="/calls"
                  variant="subtle"
                  size="xs"
                  rightSection={<IconArrowUpRight size={15} />}
                >
                  View all calls
                </Button>
              }
            >
              <CallsTable calls={data.recent_calls} />
            </Panel>
            <Panel
              title="Today’s Live allowance"
              aside={
                <Text size="xs" c="dimmed">
                  {data.today_usage.date} · {data.timezone}
                </Text>
              }
            >
              <Fields
                rows={[
                  ["Daily limit", seconds(data.today_usage.limit_seconds)],
                  ["Settled", seconds(data.today_usage.settled_seconds)],
                  ["Reserved", seconds(data.today_usage.reserved_seconds)],
                  ["Unknown", seconds(data.today_usage.unknown_seconds)],
                  ["Remaining", seconds(data.today_usage.remaining_seconds)],
                ]}
              />
            </Panel>
          </Stack>
        )
      )}
    </>
  );
}
function Metric({
  title,
  value,
  note,
}: {
  title: string;
  value: string;
  note: string;
}) {
  return (
    <Paper p="lg" radius="lg" withBorder>
      <Text size="sm" c="dimmed" fw={500}>
        {title}
      </Text>
      <Title order={2} className="metric" mt={14} mb={12}>
        {value}
      </Title>
      <Text size="xs" c="dimmed" lh={1.6}>
        {note}
      </Text>
    </Paper>
  );
}
