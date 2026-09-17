import { useState } from "react";
import { Alert, Button, Group, PasswordInput, Stack } from "@mantine/core";
import type {
  ConfigurationSecret,
  ConsoleConfiguration,
  ConsoleConfigurationView,
} from "../../../packages/contracts/src/console-configuration";
import { api, queryClient } from "./api";
import { Failure } from "./shared";

export function useConfigurationForm(initial: ConsoleConfigurationView) {
  const [baseline, setBaseline] = useState(initial);
  const [settings, setSettings] = useState<ConsoleConfiguration>(() =>
    structuredClone(initial.settings),
  );
  const [secrets, setSecrets] = useState<
    Partial<Record<ConfigurationSecret, string>>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const update = <K extends keyof ConsoleConfiguration>(
    key: K,
    value: ConsoleConfiguration[K],
  ) => {
    setSettings((old) => ({ ...old, [key]: value }));
    setSaved(false);
  };
  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api<ConsoleConfigurationView>(
        "/settings/configuration",
        {
          method: "PUT",
          body: JSON.stringify({
            expected_revision: baseline.revision,
            settings,
            secrets: Object.fromEntries(
              Object.entries(secrets).filter(([, value]) => value !== ""),
            ),
          }),
        },
      );
      setBaseline(next);
      setSettings(structuredClone(next.settings));
      setSecrets({});
      setSaved(true);
      await queryClient.invalidateQueries();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<ConsoleConfigurationView>(
        "/settings/configuration",
      );
      setBaseline(next);
      setSettings(structuredClone(next.settings));
      setSecrets({});
      setSaved(false);
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  return {
    baseline,
    settings,
    update,
    busy,
    secret: (key: ConfigurationSecret, label: string) => (
      <PasswordInput
        label={label}
        description={
          baseline.credentials[key]
            ? "Configured. Leave blank to keep the current credential."
            : "No credential configured."
        }
        value={secrets[key] ?? ""}
        autoComplete="new-password"
        onChange={(event) => {
          setSecrets({ ...secrets, [key]: event.currentTarget.value });
          setSaved(false);
        }}
      />
    ),
    actions: (
      <Stack gap="sm">
        {error && <Failure error={error} />}
        {saved && (
          <Alert color="teal">
            Settings saved and applied. Calling is paused; resume it when you
            are ready.
          </Alert>
        )}
        <Group>
          <Button type="submit" loading={busy}>
            Save and apply
          </Button>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload saved settings
          </Button>
        </Group>
      </Stack>
    ),
    save,
  };
}
