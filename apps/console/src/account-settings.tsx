import { useState } from "react";
import {
  Alert,
  Button,
  PasswordInput,
  Modal,
  Group,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { api, endSession, queryClient, useResource } from "./api";
import { Failure, Fields, Loading, Panel } from "./shared";
type Account = {
  username: string;
  revision: number;
  allow_remote_management: boolean;
};
export function AccountSettings() {
  const query = useResource<Account>("/account");
  const [editing, setEditing] = useState<Account | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  async function configure() {
    setOpening(true);
    setError(null);
    setSaved(false);
    const result = await query.refetch();
    if (result.error) setError(result.error);
    else if (result.data) setEditing(result.data);
    setOpening(false);
  }
  return (
    <>
      <Panel
        title="Console account & access"
        aside={
          <Button
            variant="light"
            aria-label="Configure console account and access"
            loading={opening}
            disabled={!query.data || !!editing}
            onClick={() => void configure()}
          >
            Configure
          </Button>
        }
      >
        {query.isPending ? (
          <Loading />
        ) : (
          query.data && (
            <Fields
              rows={[
                ["Username", query.data.username],
                ["Password", "Configured"],
                [
                  "Remote management",
                  query.data.allow_remote_management
                    ? "Allowed"
                    : "Server only",
                ],
              ]}
            />
          )
        )}
        {(error || query.error) && (
          <Failure
            error={(error || query.error)!}
            retry={() => void query.refetch()}
          />
        )}
        {saved && <Alert color="teal">Account settings saved.</Alert>}
      </Panel>
      {editing && (
        <AccountForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(account) => {
            queryClient.setQueryData(["/account"], account);
            setEditing(null);
            setSaved(true);
          }}
        />
      )}
    </>
  );
}
function AccountForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Account;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const [account, setAccount] = useState(initial);
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <Modal
      opened
      title="Configure console account & access"
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
      size="lg"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const result = await api<{
              account: Account;
              login_required: boolean;
            }>("/account", {
              method: "PUT",
              body: JSON.stringify({
                ...account,
                current_password: password,
                ...(nextPassword ? { new_password: nextPassword } : {}),
              }),
            });
            setAccount(result.account);
            setPassword("");
            setNextPassword("");
            if (result.login_required) endSession();
            else onSaved(result.account);
          } catch (error) {
            setError(error as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset
          disabled={busy}
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          <Stack>
            <TextInput
              label="Username"
              autoComplete="username"
              value={account.username}
              onChange={(event) => {
                setAccount({ ...account, username: event.currentTarget.value });
              }}
              pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
              required
            />
            <PasswordInput
              label="New password"
              description="Leave blank to keep your password. Changing credentials signs you out."
              value={nextPassword}
              onChange={(event) => setNextPassword(event.currentTarget.value)}
              minLength={12}
              maxLength={256}
              autoComplete="new-password"
            />
            <Switch
              label="Allow remote management"
              description="When off, change settings and connections from the server itself. Calls and call history remain available."
              checked={account.allow_remote_management}
              onChange={(event) => {
                setAccount({
                  ...account,
                  allow_remote_management: event.currentTarget.checked,
                });
              }}
            />
            {!account.allow_remote_management && (
              <Alert color="orange">
                Saving this setting will block Settings and Connections
                management from other devices. You can re-enable it locally on
                the server.
              </Alert>
            )}
            <PasswordInput
              label="Current password"
              description="Confirm your password to save account settings."
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              autoComplete="current-password"
            />
            {error && (
              <Alert color="red" title="Unable to save account settings">
                {error.message}
              </Alert>
            )}
            <Group>
              <Button type="submit" loading={busy}>
                Save account settings
              </Button>
              <Button
                variant="default"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    setAccount(await api<Account>("/account"));
                    setPassword("");
                    setNextPassword("");
                  } catch (error) {
                    setError(error as Error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Reload saved settings
              </Button>
              <Button variant="subtle" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </Group>
          </Stack>
        </fieldset>
      </form>
    </Modal>
  );
}
