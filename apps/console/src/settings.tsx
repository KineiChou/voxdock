import {
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import type { ConsoleSettings } from "../../../packages/contracts/src/console";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { useResource } from "./api";
import { Failure, Loading, PageTitle, Panel } from "./shared";
import { CallingControl } from "./calling-control";
import { AccountSettings } from "./account-settings";
import { useConfigurationForm } from "./configuration-form";
export function Settings() {
  const status = useResource<ConsoleSettings>("/settings");
  const query = useResource<ConsoleConfigurationView>(
    "/settings/configuration",
  );
  return (
    <>
      <PageTitle
        title="Settings"
        description="Manage calling, voice, your agent, and console access."
        action={status.data && <CallingControl settings={status.data} />}
      />
      <Stack gap="lg">
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <Failure error={query.error} retry={() => void query.refetch()} />
        ) : (
          query.data && <SettingsForm initial={query.data} />
        )}
        <AccountSettings />
      </Stack>
    </>
  );
}
function SettingsForm({ initial }: { initial: ConsoleConfigurationView }) {
  const form = useConfigurationForm(initial);
  const { settings: s, update } = form;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <Stack gap="lg">
        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          <Panel title="Calling limits">
            <Stack>
              <Switch
                label="Enable calling"
                checked={s.calling.enabled}
                onChange={(event) =>
                  update("calling", {
                    ...s.calling,
                    enabled: event.currentTarget.checked,
                  })
                }
              />
              {(
                [
                  ["max_call_seconds", "Maximum call duration (seconds)", 3600],
                  [
                    "daily_live_seconds",
                    "Daily Live allowance (seconds)",
                    86400,
                  ],
                  ["ring_timeout_seconds", "Ring timeout (seconds)", 120],
                  [
                    "max_request_ttl_seconds",
                    "Request lifetime (seconds)",
                    3600,
                  ],
                ] as const
              ).map(([key, title, max]) => (
                <NumberInput
                  key={key}
                  label={title}
                  value={s.calling[key]}
                  min={1}
                  max={max}
                  allowDecimal={false}
                  required
                  onChange={(value) =>
                    update("calling", { ...s.calling, [key]: value })
                  }
                />
              ))}
              <TextInput
                label="Timezone"
                value={form.baseline.deployment.timezone}
                readOnly
              />
            </Stack>
          </Panel>
          <Panel title="Voice">
            <Stack>
              <TextInput label="Model" value={s.live.model} readOnly />
              <TextInput
                label="Voice"
                value={s.live.voice}
                maxLength={80}
                required
                onChange={(event) =>
                  update("live", {
                    ...s.live,
                    voice: event.currentTarget.value,
                  })
                }
              />
              <TextInput
                label="Preferred language"
                value={s.live.language}
                minLength={2}
                maxLength={80}
                required
                onChange={(event) =>
                  update("live", {
                    ...s.live,
                    language: event.currentTarget.value,
                  })
                }
              />
              {form.secret("live_api_key", "Live API key")}
            </Stack>
          </Panel>
          <Panel title="Agent backend">
            <Stack>
              <Switch
                label="Connect an agent backend"
                checked={!!s.backend}
                onChange={(event) =>
                  update(
                    "backend",
                    event.currentTarget.checked
                      ? { id: "agent", base_url: "", ack_timeout_ms: 5000 }
                      : null,
                  )
                }
              />
              {s.backend && (
                <>
                  <TextInput
                    label="Backend name"
                    value={s.backend.id}
                    required
                    onChange={(event) =>
                      update("backend", {
                        ...s.backend!,
                        id: event.currentTarget.value,
                      })
                    }
                  />
                  <TextInput
                    label="Backend URL"
                    type="url"
                    value={s.backend.base_url}
                    required
                    onChange={(event) =>
                      update("backend", {
                        ...s.backend!,
                        base_url: event.currentTarget.value,
                      })
                    }
                  />
                  <NumberInput
                    label="Acknowledgement timeout (milliseconds)"
                    min={100}
                    max={30000}
                    allowDecimal={false}
                    value={s.backend.ack_timeout_ms}
                    onChange={(value) =>
                      update("backend", {
                        ...s.backend!,
                        ack_timeout_ms: Number(value),
                      })
                    }
                    required
                  />
                  {form.secret("backend_request_token", "Request token")}
                  {form.secret(
                    "backend_event_signing_key",
                    "Event signing key",
                  )}
                </>
              )}
            </Stack>
          </Panel>
          <Panel title="Records & retention">
            <Stack>
              <NumberInput
                label="Conversation retention (days)"
                description="Use 0 to disable conversation capture."
                min={0}
                max={30}
                allowDecimal={false}
                required
                value={s.records.transcript_retention_days}
                onChange={(value) =>
                  update("records", {
                    ...s.records,
                    transcript_retention_days: Number(value),
                  })
                }
              />
              <NumberInput
                label="Detailed history retention (days)"
                min={1}
                max={365}
                allowDecimal={false}
                required
                value={s.records.metadata_retention_days}
                onChange={(value) =>
                  update("records", {
                    ...s.records,
                    metadata_retention_days: Number(value),
                  })
                }
              />
              <TextInput label="Raw audio" value="Not stored" readOnly />
            </Stack>
          </Panel>
        </SimpleGrid>
        {form.actions}
      </Stack>
    </form>
  );
}
