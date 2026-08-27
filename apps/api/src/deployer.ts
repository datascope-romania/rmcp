import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteAllParams, deleteSecret, deployServer, destroyFunction,
  listRmcpFunctions, undeployServer, type StepEvent,
} from "@rmcp/deployer";
import type { DeployTarget, ServerRecord } from "@rmcp/shared";
import { makeAwsClients } from "./aws.js";
import { deployLocal, removeLocalStaging, undeployLocal, type LocalDeps } from "./local/deployer.js";
import type { Settings } from "./repo.js";

export interface DeployerPort {
  deploy(record: ServerRecord, target: DeployTarget, secrets: Record<string, string>, onEvent: (e: StepEvent) => void): Promise<{ endpointUrl: string; bearerToken: string; oauthClientId?: string; oauthClientSecret?: string }>;
  undeploy(record: ServerRecord): Promise<void>;
  deleteAllParams(serverId: string): Promise<void>;
  deleteRemoteSecret(serverId: string, key: string): Promise<void>;
  removeLocalStaging(serverId: string): Promise<void>;
  listOrphans(): Promise<{ functionName: string; serverId: string }[]>;
  destroyFunction(functionName: string): Promise<void>;
}

export function createDeployer(getSettings: () => Settings, bridgeBundlePath: string, local: LocalDeps): DeployerPort {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), "rmcp-work-"));
  const clients = () => makeAwsClients(getSettings());
  return {
    deploy: (record, target, secrets, onEvent) =>
      target === "local"
        ? deployLocal(record, secrets, local, onEvent)
        : deployServer(record, { clients: clients(), bridgeBundlePath, workRoot, onEvent, secrets }),
    undeploy: (record) =>
      record.deployedTarget === "local"
        ? undeployLocal(record, local)
        : undeployServer(record, { clients: clients() }),
    deleteAllParams: (serverId) => deleteAllParams(clients().ssm, serverId),
    deleteRemoteSecret: (serverId, key) => deleteSecret(clients().ssm, serverId, key),
    removeLocalStaging: (serverId) => removeLocalStaging(local.localRoot, serverId),
    listOrphans: () => listRmcpFunctions(clients().lambda),
    destroyFunction: (functionName) => destroyFunction(clients().lambda, functionName),
  };
}
