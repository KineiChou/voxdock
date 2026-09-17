import {
  Button,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  TextInput,
  Text,
} from "@mantine/core";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { useConfigurationForm } from "./configuration-form";
import { Panel } from "./shared";
export function ConnectionSettings({
  initial,
}: {
  initial: ConsoleConfigurationView;
}) {
  const form = useConfigurationForm(initial);
  const { settings: s, update } = form;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <Stack>
        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          {(["telegram", "whatsapp"] as const).map((channel) => {
            const target = s.targets.find((item) => item.channel === channel);
            const setTarget = (patch: Partial<NonNullable<typeof target>>) =>
              update(
                "targets",
                s.targets.map((item) =>
                  item.channel === channel ? { ...item, ...patch } : item,
                ),
              );
            return (
              <Panel
                key={channel}
                title={`${channel === "telegram" ? "Telegram" : "WhatsApp"} settings`}
              >
                <Stack>
                  <Switch
                    label="Enable channel"
                    checked={s[channel].enabled}
                    onChange={(event) =>
                      update(channel, {
                        ...s[channel],
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                  <TextInput
                    label="Account reference"
                    value={s[channel].account_ref}
                    required
                    onChange={(event) =>
                      update(channel, {
                        ...s[channel],
                        account_ref: event.currentTarget.value,
                      })
                    }
                  />
                  {channel === "telegram" ? (
                    <>
                      <NumberInput
                        label="Telegram API ID"
                        min={1}
                        max={2147483647}
                        allowDecimal={false}
                        value={s.telegram.api_id ?? ""}
                        onChange={(value) =>
                          update("telegram", {
                            ...s.telegram,
                            api_id: value === "" ? null : Number(value),
                          })
                        }
                      />
                      {form.secret("telegram_api_hash", "Telegram API hash")}
                      <Text size="xs" c="dimmed">
                        Save your credentials with the channel disabled, connect
                        your account, then enable the channel.
                      </Text>
                    </>
                  ) : (
                    <TextInput
                      label="WhatsApp service"
                      value={
                        form.baseline.deployment.whatsapp_endpoint ??
                        "Not configured"
                      }
                      readOnly
                    />
                  )}
                  <Text fw={600} size="sm" mt="sm">
                    Call target
                  </Text>
                  {target ? (
                    <>
                      <TextInput
                        label="Target name"
                        value={target.id}
                        required
                        onChange={(event) =>
                          setTarget({ id: event.currentTarget.value })
                        }
                      />
                      <TextInput
                        label="Target account reference"
                        value={target.account_ref}
                        required
                        onChange={(event) =>
                          setTarget({ account_ref: event.currentTarget.value })
                        }
                      />
                      <TextInput
                        label="Contact reference"
                        value={target.principal_ref}
                        required
                        onChange={(event) =>
                          setTarget({
                            principal_ref: event.currentTarget.value,
                          })
                        }
                      />
                      <TextInput
                        label={
                          channel === "telegram"
                            ? "Telegram peer ID"
                            : "WhatsApp peer ID"
                        }
                        value={target.peer_id}
                        required
                        onChange={(event) =>
                          setTarget({ peer_id: event.currentTarget.value })
                        }
                      />
                      <Switch
                        label="Enable target"
                        checked={target.enabled}
                        onChange={(event) =>
                          setTarget({ enabled: event.currentTarget.checked })
                        }
                      />
                      <Button
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          update(
                            "targets",
                            s.targets.filter(
                              (item) => item.channel !== channel,
                            ),
                          )
                        }
                      >
                        Remove target
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="default"
                      onClick={() =>
                        update("targets", [
                          ...s.targets,
                          {
                            id: `${channel}-target`,
                            channel,
                            account_ref: s[channel].account_ref,
                            principal_ref: "",
                            peer_id: "",
                            enabled: false,
                          },
                        ])
                      }
                    >
                      Add call target
                    </Button>
                  )}
                </Stack>
              </Panel>
            );
          })}
        </SimpleGrid>
        {form.actions}
      </Stack>
    </form>
  );
}
