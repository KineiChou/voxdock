import { Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type { ConsoleConnections } from "../../../packages/contracts/src/console";
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
  Status,
} from "./shared";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { ConnectionSettings } from "./connection-settings";
import { ConnectionLogin } from "./connection-login";
export function Connections() {
  const configuration = useResource<ConsoleConfigurationView>(
    "/settings/configuration",
  );
  const query = useResource<ConsoleConnections>("/connections");
  return (
    <>
      <PageTitle
        title="Connections"
        description="Your channels, connected accounts, and configured call targets."
      />
      {configuration.error && <Failure error={configuration.error} />}
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
                      [
                        "Account connection",
                        channel.authenticated ? "Connected" : "Disconnected",
                      ],
                      [
                        "Calling readiness",
                        channel.ready ? "Ready" : "Not ready",
                      ],
                    ]}
                  />
                  <ConnectionLogin
                    channel={channel.channel}
                    authenticated={channel.authenticated}
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
            {configuration.data && (
              <Stack mt="lg">
                <ConnectionSettings initial={configuration.data} />
              </Stack>
            )}
            <Text size="xs" c="dimmed" mt="lg">
              Last checked {date(query.data.checked_at)}
            </Text>
          </>
        )
      )}
    </>
  );
}
