import { Alert, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type {
  ConsoleConnections,
  ConsoleSettings,
} from "../../../packages/contracts/src/console";
import { useResource } from "./api";
import {
  date,
  Empty,
  Failure,
  Fields,
  label,
  Loading,
  PageTitle,
  Panel,
  seconds,
  Status,
} from "./shared";
import { CallingControl } from "./calling-control";
export function Connections() {
  const query = useResource<ConsoleConnections>("/connections");
  return (
    <>
      <PageTitle
        title="Connections"
        description="Your channels, connected accounts, and configured call targets."
      />
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        query.data && (
          <>
            <SimpleGrid cols={{ base: 1, lg: 2 }}>
              {query.data.channels.map((channel) => (
                <Panel
                  key={channel.channel}
                  title={label(channel.channel)}
                  aside={<Status value={channel.status} />}
                >
                  <Fields
                    rows={[
                      ["Account", channel.account_ref ?? "Not configured"],
                      ["Calling", channel.enabled ? "Enabled" : "Disabled"],
                      ["Connection", channel.ready ? "Ready" : "Not ready"],
                    ]}
                  />
                  <Text fw={600} size="sm" mt="xl" mb="sm">
                    Call targets
                  </Text>
                  {!channel.targets.length ? (
                    <Empty
                      title="No targets configured"
                      text="Configured call targets will appear here."
                    />
                  ) : (
                    <Stack gap="xs">
                      {channel.targets.map((target) => (
                        <div className="record-block" key={target.id}>
                          <Group justify="space-between">
                            <Text fw={600} size="sm">
                              {target.id}
                            </Text>
                            <Status
                              value={target.enabled ? "enabled" : "disabled"}
                            />
                          </Group>
                          <Text c="dimmed" size="sm" mt={5}>
                            {target.principal_ref}
                          </Text>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Panel>
              ))}
            </SimpleGrid>
            <Text size="xs" c="dimmed" mt="lg">
              Last checked {date(query.data.checked_at)}
            </Text>
          </>
        )
      )}
    </>
  );
}
export function Settings() {
  const query = useResource<ConsoleSettings>("/settings");
  const data = query.data;
  return (
    <>
      <PageTitle
        title="Settings"
        description="The settings currently applied to your workspace."
        action={data && <CallingControl settings={data} />}
      />
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        data && (
          <Stack gap="lg">
            <Alert color="gray">
              These settings are managed through your deployment configuration
              and are read-only here.
            </Alert>
            <SimpleGrid cols={{ base: 1, lg: 2 }}>
              <Panel title="Calling limits">
                <Fields
                  rows={[
                    [
                      "Calling configured",
                      data.calling.configured_enabled ? "Enabled" : "Disabled",
                    ],
                    [
                      "Accepting new calls",
                      data.calling.accepting_calls ? "Yes" : "No",
                    ],
                    [
                      "Maximum call duration",
                      seconds(data.calling.max_call_seconds),
                    ],
                    [
                      "Daily Live allowance",
                      seconds(data.calling.daily_live_seconds),
                    ],
                    [
                      "Ring timeout",
                      seconds(data.calling.ring_timeout_seconds),
                    ],
                    [
                      "Request lifetime",
                      seconds(data.calling.max_request_ttl_seconds),
                    ],
                    ["Timezone", data.timezone],
                  ]}
                />
              </Panel>
              <Panel title="Voice & agent">
                <Fields
                  rows={[
                    ["Model", data.live.model],
                    ["Voice", data.live.voice],
                    ["Language", data.live.language],
                    [
                      "Live credential",
                      data.live.credential_configured
                        ? "Configured"
                        : "Not configured",
                    ],
                    [
                      "Agent backend",
                      data.backend.configured ? "Configured" : "Not configured",
                    ],
                    ["Backend name", data.backend.id ?? "—"],
                  ]}
                />
              </Panel>
            </SimpleGrid>
            <Panel title="Records & retention">
              <Fields
                rows={[
                  ["Raw audio", "Not stored"],
                  [
                    "Conversation retention",
                    `${data.records.transcript_retention_days} days`,
                  ],
                  [
                    "Call metadata retention",
                    `${data.records.metadata_retention_days} days`,
                  ],
                ]}
              />
            </Panel>
          </Stack>
        )
      )}
    </>
  );
}
