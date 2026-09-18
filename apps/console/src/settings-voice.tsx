import { useState } from "react";
import { Alert, Button, Select, Switch, Textarea, TextInput } from "@mantine/core";
import type { ConsoleSettingsOptions } from "../../../packages/contracts/src/console-configuration";
import { useResource } from "./api";
import { Fields, Loading } from "./shared";
import type { useConfigurationForm } from "./configuration-form";

type Choice = { value: string; label: string };

export function SearchableSetting({
  label,
  value,
  choices,
  allowCustom,
  minLength = 1,
  onChange,
}: {
  label: string;
  value: string;
  choices: Choice[];
  allowCustom: boolean;
  minLength?: number;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const data = [...choices];
  if (!data.some((option) => option.value === value))
    data.push({ value, label: `${value} (current)` });
  const custom = search.trim();
  if (
    allowCustom &&
    custom.length >= minLength &&
    custom.length <= 80 &&
    !data.some((option) => option.value === custom)
  )
    data.push({ value: custom, label: `Use “${custom}”` });
  return (
    <Select
      label={label}
      value={value}
      data={data}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options, search }) => options.filter((option) =>
        "value" in option && `${option.label} ${option.value}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      )}
      onChange={(next) => {
        if (next) onChange(next);
      }}
      nothingFoundMessage="No matching options"
      description={
        allowCustom
          ? "Search available options or enter a custom value."
          : undefined
      }
      required
    />
  );
}

export function VoiceFields({
  form,
  options,
}: {
  form: ReturnType<typeof useConfigurationForm>;
  options: ReturnType<typeof useResource<ConsoleSettingsOptions>>;
}) {
  const live = form.settings.live;
  return (
    <>
      <Fields rows={[["Model", live.model]]} />
      {options.isPending ? (
        <Loading />
      ) : options.error ? (
        <Alert color="red" title="Voice options unavailable">
          {options.error.message}
          <Button variant="subtle" onClick={() => void options.refetch()}>
            Reload options
          </Button>
        </Alert>
      ) : (
        options.data && (
          <>
            <SearchableSetting
              label="Voice"
              value={live.voice}
              choices={options.data.voices}
              allowCustom={options.data.allow_custom_voice}
              onChange={(voice) => form.update("live", { ...live, voice })}
            />
            <SearchableSetting
              label="Preferred language"
              value={live.language}
              choices={options.data.languages}
              allowCustom={options.data.allow_custom_language}
              minLength={2}
              onChange={(language) =>
                form.update("live", { ...live, language })
              }
            />
          </>
        )
      )}
      <TextInput
        label="Custom voice ID"
        description="Optional voice_… ID. When set, it replaces the selected voice."
        value={live.custom_voice_id}
        maxLength={80}
        onChange={(event) => form.update("live", { ...live, custom_voice_id: event.currentTarget.value })}
      />
      <Switch
        label="Greet when the call connects"
        checked={live.greeting_enabled}
        onChange={(event) => form.update("live", { ...live, greeting_enabled: event.currentTarget.checked })}
      />
      <Textarea
        label="Conversation instructions"
        description="Describe the tone, speaking style, and when to ask your agent for help."
        value={live.instructions}
        maxLength={16000}
        autosize minRows={3} maxRows={8}
        onChange={(event) => form.update("live", { ...live, instructions: event.currentTarget.value })}
      />
      {form.secret("live_api_key", "Live API key")}
    </>
  );
}
