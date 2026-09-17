import { SimpleGrid, Text } from "@mantine/core";
import type { ConsoleConnections } from "../../../packages/contracts/src/console";
import { useResource } from "./api";
import {
  date,
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
import { WhatsAppSetup } from "./whatsapp-setup";
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
                  {channel.channel === "whatsapp" ? (
                    <WhatsAppSetup />
                  ) : (
                    <>
                      <ConnectionLogin
                        channel="telegram"
                        authenticated={channel.authenticated}
                      />
                      <Text size="sm" mt="lg">
                        Receiving account:{" "}
                        {configuration.data?.settings.targets.find(
                          (target) => target.channel === "telegram",
                        )?.peer_id ?? "Not configured"}
                      </Text>
                      {configuration.data && (
                        <ConnectionSettings initial={configuration.data} />
                      )}
                    </>
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
