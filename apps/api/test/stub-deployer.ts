import { vi } from "vitest";
import type { DeployerPort } from "../src/deployer.js";

export function makeStubDeployer(): DeployerPort {
  return {
    deploy: vi.fn(async (_rec, _target, _secrets, onEvent) => {
      onEvent({ step: "stage", status: "start" });
      onEvent({ step: "stage", status: "ok" });
      return { endpointUrl: "https://f.lambda-url.aws/", bearerToken: "tok-1" };
    }),
    undeploy: vi.fn(async () => {}),
    deleteAllParams: vi.fn(async () => {}),
    deleteRemoteSecret: vi.fn(async () => {}),
    removeLocalStaging: vi.fn(async () => {}),
    listOrphans: vi.fn(async () => []),
    destroyFunction: vi.fn(async () => {}),
  };
}
