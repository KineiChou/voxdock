import { useState } from "react";
import {
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
  section,
  onSaved,
  onClose,
}: {
  initial: ConsoleConfigurationView;
  section: "application" | "calling";
  onSaved: () => void;
  onClose: () => void;
}) {
  const form = useConfigurationForm(initial);
  const { settings, update } = form;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.save().then((saved) => {
          if (saved) onSaved();
        });
      }}
    >
      <Stack>
        {section === "application" ? (
          <>
            <NumberInput
              label="Telegram API ID"
              required
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
          </>
        ) : (
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
        )}
        {form.actions}
        <Button variant="subtle" disabled={form.busy} onClick={onClose}>
          Cancel changes
        </Button>
      </Stack>
    </form>
  );
}
export function TelegramTarget({
  initial,
  onSaved,
  onClose,
}: {
  initial: ConsoleConfigurationView;
  onSaved: () => void;
  onClose: () => void;
}) {
  const target = initial.settings.targets.find(
    (item) => item.channel === "telegram",
  );
  const [peer, setPeer] = useState(target?.peer_id ?? "");
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api<ConsoleConfigurationView>("/connections/telegram/target", {
        method: "POST",
        body: JSON.stringify({ peer_id: peer, enabled }),
      });
      await queryClient.invalidateQueries();
      onSaved();
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
          }}
        />
        <Switch
          label="Enable this receiving account"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.currentTarget.checked);
          }}
        />
        {error && <Failure error={error} />}
        <Button type="submit" loading={busy}>
          Save receiving account
        </Button>
        <Button variant="subtle" disabled={busy} onClick={onClose}>
          Cancel changes
        </Button>
      </Stack>
    </form>
  );
}
