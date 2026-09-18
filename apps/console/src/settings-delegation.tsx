import { Accordion, Alert, Button, NumberInput, Select, Stack, Switch, Text, Textarea } from "@mantine/core";
import type { ConsoleSettingsOptions } from "../../../packages/contracts/src/console-configuration";
import type { LiveResponsesPreferences } from "../../../packages/contracts/src/live-settings";
import type { useConfigurationForm } from "./configuration-form";
import { useResource } from "./api";
import { Loading } from "./shared";
import { SearchableSetting } from "./settings-voice";

export function DelegationFields({ form, options }: {
  form: ReturnType<typeof useConfigurationForm>;
  options: ReturnType<typeof useResource<ConsoleSettingsOptions>>;
}) {
  const live = form.settings.live;
  const responses = live.responses;
  const update = (patch: Partial<LiveResponsesPreferences>) =>
    form.update("live", { ...live, responses: { ...responses, ...patch } });
  if (options.isPending) return <Loading />;
  if (options.error || !options.data) return (
    <Alert color="red" title="Delegation options unavailable">
      {options.error?.message}
      <Button variant="subtle" onClick={() => void options.refetch()}>Reload options</Button>
    </Alert>
  );
  const choices = options.data;
  return (
    <>
      <Select
        label="Handle delegated tasks with"
        data={choices.delegation_modes}
        value={live.delegation}
        allowDeselect={false}
        onChange={(value) => {
          if (value) form.update("live", { ...live, delegation: value as typeof live.delegation });
        }}
      />
      {live.delegation === "client" ? (
        <Text size="sm">
          Your external agent handles reasoning, web access, and custom actions.
          Configure its connection under Agent connection.
        </Text>
      ) : (
        <>
          <Text size="sm">
            OpenAI manages delegated reasoning and optional web search.
            Your connected backend still supplies call context and receives events.
            Use External agent for custom actions.
          </Text>
          <SearchableSetting
            label="Responses model"
            value={responses.model}
            choices={choices.responses_models}
            allowCustom={choices.allow_custom_responses_model}
            onChange={(model) => update({ model })}
          />
          <Text size="xs" c="dimmed">
            Model access and supported settings depend on your OpenAI account
            and chosen model. Saving does not verify access.
          </Text>
          <Textarea
            label="Delegated task instructions"
            description="Guide reasoning and web research separately from the voice conversation."
            value={responses.instructions}
            maxLength={16000}
            autosize minRows={3} maxRows={8}
            onChange={(event) => update({ instructions: event.currentTarget.value })}
          />
          <Switch
            label="Enable web search"
            description="Allow delegated tasks to search the web."
            checked={responses.web_search}
            onChange={(event) => update({ web_search: event.currentTarget.checked })}
          />
          <Accordion variant="separated">
            <Accordion.Item value="responses-options">
              <Accordion.Control>Reasoning, output & tool settings</Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  <Select
                    label="Reasoning effort"
                    data={choices.reasoning_efforts}
                    value={responses.reasoning_effort}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value) update({ reasoning_effort: value as LiveResponsesPreferences["reasoning_effort"] });
                    }}
                  />
                  <NumberInput
                    label="Maximum output tokens"
                    value={responses.max_output_tokens}
                    min={16} max={16384} allowDecimal={false} required
                    onChange={(value) => update({ max_output_tokens: Number(value) })}
                  />
                  <Select
                    label="Service tier"
                    data={choices.service_tiers}
                    value={responses.service_tier}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value) update({ service_tier: value as LiveResponsesPreferences["service_tier"] });
                    }}
                  />
                  <Select
                    label="Response detail"
                    description="Controls delegated text output, not the speaking style."
                    data={choices.verbosities}
                    value={responses.verbosity}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value) update({ verbosity: value as LiveResponsesPreferences["verbosity"] });
                    }}
                  />
                  <Select
                    label="Tool use"
                    description="Required needs web search enabled. None prevents tool use."
                    data={choices.tool_choices}
                    value={responses.tool_choice}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value) update({ tool_choice: value as LiveResponsesPreferences["tool_choice"] });
                    }}
                  />
                  <Switch
                    label="Allow parallel tool calls"
                    checked={responses.parallel_tool_calls}
                    onChange={(event) => update({ parallel_tool_calls: event.currentTarget.checked })}
                  />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </>
  );
}
