import { DEFAULT_MODEL_DISPLAY_NAME, parseModelSelection, type RunDetail } from "@cua-sample/contracts";

import { RunnerCoreError } from "./errors.js";
import { createExternalCodeModel, runExternalCodeLoop } from "./model-providers.js";
import { createDefaultResponsesClient, runResponsesCodeLoop } from "./responses-loop.js";
import {
  createUnsupportedScenarioError,
  runWorkspaceLabBrowserFlow,
  type RunExecutor,
} from "./scenario-runtime.js";
import { getLabInstructions } from "./lab-catalog.js";

type Lab = {
  id: string;
};

const labs: Record<string, Lab> = {
  "booking-complete-reservation": { id: "booking" },
  "kanban-reprioritize-sprint": { id: "kanban" },
  "paint-draw-poster": { id: "paint" },
};

export function createDefaultRunExecutor(detail: RunDetail): RunExecutor {
  if (detail.scenario.labId === "desktop") {
    throw new RunnerCoreError("Unreal Editor runs on the Python desktop backend.", {
      code: "desktop_backend_required",
      hint: "Stop this app, start it with pnpm dev:python, and leave Unreal Editor in front on the primary display.",
      statusCode: 400,
    });
  }
  const lab = labs[detail.scenario.id];
  if (!lab) throw createUnsupportedScenarioError(detail.scenario.id);

  return {
    async execute(context) {
      const selection = parseModelSelection(context.detail.run.model);
      const openaiClient = selection.provider === "openai" ? createDefaultResponsesClient() : null;
      const externalModel = openaiClient ? null : createExternalCodeModel(context.detail.run.model);
      const providerMessage = selection.provider === "openai"
        ? `Using the live Responses API code loop for the ${lab.id} lab.`
        : `Using the ${selection.provider === "anthropic" ? "Claude" : "OpenAI-compatible"} code loop for the ${lab.id} lab.`;
      await context.emitEvent({
        detail: context.detail.run.model,
        level: "ok",
        message: providerMessage,
        type: "run_progress",
      });
      await runWorkspaceLabBrowserFlow(context, {
        loadedScreenshotLabel: `${lab.id}-loaded`,
        navigationMessage: `Browser navigated to the ${lab.id} lab.`,
        runner: async ({ labUrl, session }) => {
          const harnessName = selection.provider === "openai" ? DEFAULT_MODEL_DISPLAY_NAME : selection.modelId;
          const instructions = [
            `You are operating a persistent Playwright browser session for a ${harnessName} CUA demo harness.`,
            "You must use the exec_js tool before you answer.",
            ...(lab.id === "paint" ? ["Observe the interface with display((await page.screenshot()).toString('base64')), then use Playwright locators, page.mouse, and page.keyboard to operate the visible controls. Mouse coordinates refer to the page screenshot."] : []),
            `The lab is already open at ${labUrl}.`,
            ...getLabInstructions(lab.id),
          ].join("\n");
          const result = openaiClient
            ? await runResponsesCodeLoop({
              context,
              instructions,
              maxResponseTurns: context.detail.run.maxResponseTurns,
              prompt: context.detail.run.prompt.trim(),
              session,
            }, openaiClient)
            : await runExternalCodeLoop({
              context,
              instructions,
              maxResponseTurns: context.detail.run.maxResponseTurns,
              model: externalModel!,
              session,
            });
          return {
            notes: result.notes,
          };
        },
        sessionLabel: `run-scoped ${lab.id} lab`,
        finalScreenshotLabel: `${lab.id}-final`,
      });
    },
  };
}
