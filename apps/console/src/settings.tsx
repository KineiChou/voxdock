import { useState } from "react";
import { Alert, Button, SimpleGrid, Stack } from "@mantine/core";
import type { ConsoleSettings } from "../../../packages/contracts/src/console";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { useResource } from "./api";
import { Fields, Loading, PageTitle, Panel } from "./shared";
import { CallingControl } from "./calling-control";
import { AccountSettings } from "./account-settings";
import {
  SettingsEditor,
  type SettingsGroup,
  settingsTitles,
} from "./settings-editor";

export function Settings() {
  const status = useResource<ConsoleSettings>("/settings");
  const query = useResource<ConsoleConfigurationView>(
    "/settings/configuration",
  );
  const [editing, setEditing] = useState<{
    group: SettingsGroup;
    initial: ConsoleConfigurationView;
  } | null>(null);
  const [opening, setOpening] = useState<SettingsGroup | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  async function configure(group: SettingsGroup) {
    setOpening(group);
    setError(null);
    setSaved(false);
    const result = await query.refetch();
    if (result.error) setError(result.error);
    else if (result.data) setEditing({ group, initial: result.data });
    setOpening(null);
  }
  const view = query.data;
  const s = view?.settings;
  const rows: Record<SettingsGroup, Array<[string, React.ReactNode]>> | null =
    s && view
      ? {
          live: [
            ["Voice", s.live.voice],
            ["Preferred language", s.live.language],
            ["Model", s.live.model],
            [
              "Live API key",
              view.credentials.live_api_key ? "Configured" : "Not configured",
            ],
          ],
          calling: [
            ["Calling", s.calling.enabled ? "Enabled" : "Disabled"],
            ["Maximum call duration", `${s.calling.max_call_seconds} seconds`],
            ["Daily Live allowance", `${s.calling.daily_live_seconds} seconds`],
            ["Ring timeout", `${s.calling.ring_timeout_seconds} seconds`],
            [
              "Request lifetime",
              `${s.calling.max_request_ttl_seconds} seconds`,
            ],
            ["Timezone", view.deployment.timezone],
          ],
          backend: [
            ["Agent connection", s.backend ? "Enabled" : "Disabled"],
            ...(s.backend
              ? ([
                  ["Backend name", s.backend.id],
                  ["Backend URL", s.backend.base_url],
                  ["Acknowledgement timeout", `${s.backend.ack_timeout_ms} ms`],
                  [
                    "Request token",
                    view.credentials.backend_request_token
                      ? "Configured"
                      : "Not configured",
                  ],
                  [
                    "Event signing key",
                    view.credentials.backend_event_signing_key
                      ? "Configured"
                      : "Not configured",
                  ],
                ] as Array<[string, string]>)
              : []),
          ],
          records: [
            [
              "Conversation retention",
              s.records.transcript_retention_days
                ? `${s.records.transcript_retention_days} days`
                : "Capture disabled",
            ],
            [
              "Detailed history retention",
              `${s.records.metadata_retention_days} days`,
            ],
            ["Raw audio", "Not stored"],
          ],
        }
      : null;
  return (
    <>
      <PageTitle
        title="Settings"
        description="Manage calling, voice, your agent, and console access."
        action={status.data && <CallingControl settings={status.data} />}
      />
      <Stack gap="lg">
        {(error || query.error) && (
          <Alert color="red" title="Unable to load settings">
            {(error || query.error)?.message}
            <Button variant="subtle" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </Alert>
        )}
        {saved && <Alert color="teal">Settings saved and applied.</Alert>}
        {query.isPending ? (
          <Loading />
        ) : (
          rows && (
            <SimpleGrid cols={{ base: 1, lg: 2 }}>
              {(Object.keys(settingsTitles) as SettingsGroup[]).map((group) => (
                <Panel
                  key={group}
                  title={settingsTitles[group]}
                  aside={
                    <Button
                      variant="light"
                      aria-label={`Configure ${settingsTitles[group]}`}
                      loading={opening === group}
                      disabled={opening !== null || editing !== null}
                      onClick={() => void configure(group)}
                    >
                      Configure
                    </Button>
                  }
                >
                  <Fields rows={rows[group]} />
                </Panel>
              ))}
            </SimpleGrid>
          )
        )}
        <AccountSettings />
      </Stack>
      {editing && (
        <SettingsEditor
          group={editing.group}
          initial={editing.initial}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setSaved(true);
          }}
        />
      )}
    </>
  );
}
