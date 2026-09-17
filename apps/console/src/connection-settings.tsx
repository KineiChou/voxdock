import { useState } from "react";
import {
  Accordion,
  Alert,
  Button,
  NumberInput,
  Stack,
  Switch,
  TextInput,
  Text,
} from "@mantine/core";
import type { ConsoleConfigurationView } from "../../../packages/contracts/src/console-configuration";
import { useConfigurationForm } from "./configuration-form";
import { api, queryClient } from "./api";
import { Failure } from "./shared";
export function ConnectionSettings({
  initial,
}: {
  initial: ConsoleConfigurationView;
}) {
  const form = useConfigurationForm(initial);
  const { settings, update } = form;
  return (
    <Accordion mt="lg" variant="separated">
      <Accordion.Item value="telegram-settings">
        <Accordion.Control>Telegram setup</Accordion.Control>
        <Accordion.Panel>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.save();
            }}
          >
            <Stack>
              <Text size="sm">
                Save your Telegram API credentials, then connect your account
                above. Enable calling after you have connected and added a
                receiving account.
              </Text>
              <NumberInput
                label="Telegram API ID"
                min={1}
                max={2147483647}
                allowDecimal={false}
                value={settings.telegram.api_id ?? ""}
                onChange={(value) =>
                  update("telegram", {
                    ...settings.telegram,
                    api_id: value === "" ? null : Number(value),
                  })
                }
              />
              {form.secret("telegram_api_hash", "Telegram API hash")}
              <Switch
                label="Enable Telegram calling"
                checked={settings.telegram.enabled}
                onChange={(event) =>
                  update("telegram", {
                    ...settings.telegram,
                    enabled: event.currentTarget.checked,
                  })
                }
              />
              {form.actions}
            </Stack>
          </form>
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="telegram-target">
        <Accordion.Control>
          Telegram receiving account · advanced
        </Accordion.Control>
        <Accordion.Panel>
          <TelegramTarget initial={initial} />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
function TelegramTarget({ initial }: { initial: ConsoleConfigurationView }) {
  const target = initial.settings.targets.find(
    (item) => item.channel === "telegram",
  );
  const [peer, setPeer] = useState(target?.peer_id ?? "");
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await api<ConsoleConfigurationView>("/connections/telegram/target", {
        method: "POST",
        body: JSON.stringify({ peer_id: peer, enabled }),
      });
      setSaved(true);
      await queryClient.invalidateQueries();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack>
        <Text size="sm">
          Telegram receiving-account pairing is not available yet. Enter the
          numeric Telegram user ID of your receiving account. The calling
          account must be able to reach this user.
        </Text>
        <TextInput
          label="Receiving Telegram user ID"
          value={peer}
          required
          onChange={(event) => {
            setPeer(event.currentTarget.value);
            setSaved(false);
          }}
        />
        <Switch
          label="Enable this receiving account"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.currentTarget.checked);
            setSaved(false);
          }}
        />
        {error && <Failure error={error} />}
        {saved && (
          <Alert color="teal">
            Receiving account saved. Review your settings before resuming calls.
            Reload saved settings before making further Telegram setup changes.
          </Alert>
        )}
        <Button type="submit" loading={busy}>
          Save receiving account
        </Button>
      </Stack>
    </form>
  );
}
