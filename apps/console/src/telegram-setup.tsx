import { useState } from "react";
import { Alert, Anchor, Button, Divider, Stack, Text } from "@mantine/core";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { api, queryClient } from "./api";
import { ConnectionSettings, TelegramTarget } from "./connection-settings";
import {
  ConnectionLogin,
  connectionTerminal,
  type ConnectionFlow,
} from "./connection-login";
import { Failure } from "./shared";

type Section = "application" | "target" | "calling";
export function TelegramSetup({
  configuration,
  authenticated,
}: {
  configuration?: ConsoleConfigurationView;
  authenticated: boolean;
}) {
  const [editor, setEditor] = useState<{
    section: Section;
    initial: ConsoleConfigurationView;
  } | null>(null);
  const [loading, setLoading] = useState<Section | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [flow, setFlow] = useState<ConnectionFlow | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const credentialsReady =
    !!configuration?.settings.telegram.api_id &&
    !!configuration.credentials.telegram_api_hash;
  const linking = loginBusy || !!(flow && !connectionTerminal(flow));
  const linked = authenticated || flow?.state === "connected";
  const target = configuration?.settings.targets.find(
    (item) => item.channel === "telegram",
  );
  const callingEnabled = !!configuration?.settings.telegram.enabled;
  const editing = !!editor || !!loading;
  async function open(section: Section) {
    setLoading(section);
    setError(null);
    try {
      // Polling never replaces an active draft; each editor opens current settings.
      const initial = await api<ConsoleConfigurationView>(
        "/settings/configuration",
        { cache: "no-store" },
      );
      queryClient.setQueryData(["/settings/configuration"], initial);
      setEditor({ section, initial });
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setLoading(null);
    }
  }
  const closeEditor = () => setEditor(null);
  return (
    <Stack mt="lg" gap="md">
      {error && <Failure error={error} />}
      <Stack gap="sm">
        <Text fw={600}>1. Telegram application</Text>
        <Text size="sm">
          Open{" "}
          <Anchor
            href="https://my.telegram.org/apps"
            target="_blank"
            rel="noopener noreferrer"
          >
            Telegram API development tools
          </Anchor>
          , sign in, and create an application to obtain your API ID and API hash.
          Save both here before linking your calling account.
        </Text>
        <Text size="sm" c="dimmed">
          {credentialsReady
            ? `Application configured · API ID ${configuration?.settings.telegram.api_id}`
            : "Application credentials required"}
        </Text>
        {editor?.section === "application" ? (
          <ConnectionSettings
            initial={editor.initial}
            section="application"
            onSaved={closeEditor}
            onClose={closeEditor}
          />
        ) : (
          <Button
            variant="light"
            disabled={linking || editing}
            loading={loading === "application"}
            onClick={() => void open("application")}
          >
            {credentialsReady
              ? "Edit application credentials"
              : "Configure application"}
          </Button>
        )}
      </Stack>
      <Divider />
      <Stack gap="sm">
        <Text fw={600}>2. Link calling account</Text>
        <Text size="sm">
          Link the Telegram account VoxDock will use to call you.
        </Text>
        {!credentialsReady && (
          <Alert>Save your API ID and API hash in step 1 to continue.</Alert>
        )}
        {editing && (
          <Text size="sm" c="dimmed">
            Save or cancel your settings changes before connecting.
          </Text>
        )}
        <ConnectionLogin
          channel="telegram"
          authenticated={authenticated}
          disabled={!credentialsReady || editing}
          onFlowChange={setFlow}
          onBusyChange={setLoginBusy}
        />
      </Stack>
      <Divider />
      <Stack gap="sm">
        <Text fw={600}>3. Receiving account</Text>
        <Text size="sm">
          Receiving Telegram user ID: {target?.peer_id ?? "Not configured"}
        </Text>
        <Text size="sm" c="dimmed">
          {target?.enabled
            ? "Receiving account enabled"
            : "Receiving account disabled"}{" "}
          · Telegram calling {callingEnabled ? "enabled" : "disabled"}
        </Text>
        {!linked && (
          <Text size="sm" c="dimmed">
            Link your calling account in step 2 before configuring the receiving
            account.
          </Text>
        )}
        {editor?.section === "target" ? (
          <TelegramTarget
            initial={editor.initial}
            onSaved={closeEditor}
            onClose={closeEditor}
          />
        ) : (
          <Button
            variant="light"
            disabled={!linked || linking || editing}
            loading={loading === "target"}
            onClick={() => void open("target")}
          >
            Configure receiving account · advanced
          </Button>
        )}
        {editor?.section === "calling" ? (
          <ConnectionSettings
            initial={editor.initial}
            section="calling"
            onSaved={closeEditor}
            onClose={closeEditor}
          />
        ) : (
          <Button
            variant="light"
            disabled={
              !linked || linking || editing || (!target?.enabled && !callingEnabled)
            }
            loading={loading === "calling"}
            onClick={() => void open("calling")}
          >
            Configure Telegram calling
          </Button>
        )}
        {linked && !target?.enabled && (
          <Text size="sm" c="dimmed">
            Save an enabled receiving account before enabling Telegram calling.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
