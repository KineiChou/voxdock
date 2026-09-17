import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import type { ConsoleConfigurationView, ConsoleSettingsOptions } from "../../../packages/contracts/src/console-configuration";
import { useResource } from "./api";
import { Fields } from "./shared";
import { useConfigurationForm } from "./configuration-form";
import { VoiceFields } from "./settings-voice";

export const settingsTitles = {
  live: "Voice & conversation",
  calling: "Calling & limits",
  backend: "Agent connection",
  records: "Data & privacy",
};
export type SettingsGroup = keyof typeof settingsTitles;
export function SettingsEditor({
  group,
  initial,
  onClose,
  onSaved,
}: {
  group: SettingsGroup;
  initial: ConsoleConfigurationView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useConfigurationForm(initial);
  const options = useResource<ConsoleSettingsOptions>("/settings/options");
  const { settings: s, update } = form;
  return (
    <Modal
      opened
      onClose={() => {
        if (!form.busy) onClose();
      }}
      title={`Configure ${settingsTitles[group]}`}
      size="lg"
      closeOnClickOutside={!form.busy}
      closeOnEscape={!form.busy}
      withCloseButton={!form.busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            form.busy ||
            (group === "live" && (!options.data || options.error))
          )
            return;
          void form.save().then((success) => {
            if (success) onSaved();
          });
        }}
      >
        <fieldset
          disabled={form.busy}
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          <Stack>
            {group === "live" ? (
              <VoiceFields form={form} options={options} />
            ) : (
              <>
                {group === "calling" && (
                  <>
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
                        [
                          "max_call_seconds",
                          "Maximum call duration (seconds)",
                          3600,
                        ],
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
                    ).map(([key, label, max]) => (
                      <NumberInput
                        key={key}
                        label={label}
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
                    <Fields
                      rows={[["Timezone", form.baseline.deployment.timezone]]}
                    />
                  </>
                )}
                {group === "backend" && (
                  <>
                    <Switch
                      label="Connect an agent backend"
                      checked={!!s.backend}
                      onChange={(event) =>
                        update(
                          "backend",
                          event.currentTarget.checked
                            ? {
                                id: "agent",
                                base_url: "",
                                ack_timeout_ms: 5000,
                              }
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
                          required
                          onChange={(value) =>
                            update("backend", {
                              ...s.backend!,
                              ack_timeout_ms: Number(value),
                            })
                          }
                        />
                        {form.secret("backend_request_token", "Request token")}
                        {form.secret(
                          "backend_event_signing_key",
                          "Event signing key",
                        )}
                      </>
                    )}
                  </>
                )}
                {group === "records" && (
                  <>
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
                    <Fields rows={[["Raw audio", "Not stored"]]} />
                  </>
                )}
              </>
            )}
            <EditorActions
              form={form}
              disabled={group === "live" && (!options.data || !!options.error)}
            />
            <Button variant="subtle" disabled={form.busy} onClick={onClose}>
              Cancel
            </Button>
          </Stack>
        </fieldset>
      </form>
    </Modal>
  );
}
type ConfigurationForm = ReturnType<typeof useConfigurationForm>;
function EditorActions({
  form,
  disabled = false,
}: {
  form: ConfigurationForm;
  disabled?: boolean;
}) {
  return (
    <Stack gap="sm">
      {form.error && (
        <Alert color="red" title="Unable to save settings">
          {form.error.message}
        </Alert>
      )}
      <Group>
        <Button type="submit" loading={form.busy} disabled={disabled}>
          Save and apply
        </Button>
        <Button
          variant="default"
          disabled={form.busy}
          onClick={() => void form.reload()}
        >
          Reload saved settings
        </Button>
      </Group>
    </Stack>
  );
}
