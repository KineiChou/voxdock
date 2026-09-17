import { useState } from "react";
import { Alert, Button, Select } from "@mantine/core";
import { useResource } from "./api";
import { Fields, Loading } from "./shared";
import type { useConfigurationForm } from "./configuration-form";

type Choice = { value: string; label: string };
export type SettingsOptions = {
  voices: Choice[];
  languages: Choice[];
  allow_custom_voice: boolean;
  allow_custom_language: boolean;
};

function SearchableSetting({
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
  options: ReturnType<typeof useResource<SettingsOptions>>;
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
      {form.secret("live_api_key", "Live API key")}
    </>
  );
}
