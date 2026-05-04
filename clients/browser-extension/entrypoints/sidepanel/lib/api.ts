import { createSharedApi } from "@agentic-browser/shared/api";

export type {
  ComposioConfigPublic,
  ComposioConnection,
  ComposioStatus,
  ComposioToolkit,
  ComposioToolSummary,
  IntegrationsStatus,
  LLMEffective,
  OAuthClientStatus,
  OAuthConnection,
  PyJIITPublic,
  SearchConfigPublic,
  SecretStatus,
  VoiceConfigPublic,
} from "@agentic-browser/shared/api";

const getBase = () => localStorage.getItem("baseUrl") || "http://localhost:5454";

export const api = createSharedApi(getBase);
