import type {
  CompatibilitySnapshot,
  DeploymentRecord,
  NetworkIdentity,
  TokenSymbol
} from "../../packages/registry/src/types.js";

export interface DeploymentIntent {
  symbol: TokenSymbol;
  startedAt: string;
}

export interface PendingDeployment {
  phase: "finalized-awaiting-verification";
  symbol: TokenSymbol;
  record: DeploymentRecord;
}

export interface DeploymentJournal {
  schemaVersion: 1;
  network: NetworkIdentity;
  compatibility: CompatibilitySnapshot;
  deployments: DeploymentRecord[];
  inFlightDeployment?: DeploymentIntent;
  pendingDeployment?: PendingDeployment;
}

export function beginDeployment(
  journal: DeploymentJournal,
  symbol: TokenSymbol,
  startedAt: string
): DeploymentJournal {
  if (journal.inFlightDeployment || journal.pendingDeployment) {
    throw new Error("Cannot begin a deployment while another deployment needs reconciliation");
  }
  return { ...journal, inFlightDeployment: { symbol, startedAt } };
}

export function recordFinalizedDeployment(
  journal: DeploymentJournal,
  record: DeploymentRecord
): DeploymentJournal {
  if (journal.inFlightDeployment?.symbol !== record.deploymentId.split(":")[0]) {
    throw new Error("Finalized deployment does not match the in-flight symbol");
  }
  const { inFlightDeployment: _inFlight, ...rest } = journal;
  return {
    ...rest,
    pendingDeployment: {
      phase: "finalized-awaiting-verification",
      symbol: record.deploymentId.split(":")[0] as TokenSymbol,
      record
    }
  };
}

export function completePendingDeployment(
  journal: DeploymentJournal,
  verified: DeploymentRecord
): DeploymentJournal {
  if (journal.pendingDeployment?.symbol !== verified.deploymentId.split(":")[0] ||
      journal.pendingDeployment.record.contractAddress !== verified.contractAddress) {
    throw new Error("Verified deployment does not match the pending finalized deployment");
  }
  const symbol = journal.pendingDeployment.symbol;
  const { pendingDeployment: _pending, ...rest } = journal;
  return {
    ...rest,
    deployments: [
      ...journal.deployments.filter((item) => item.deploymentId.split(":")[0] !== symbol),
      verified
    ]
  };
}

export function clearConfirmedAbsentIntent(journal: DeploymentJournal): DeploymentJournal {
  const { inFlightDeployment: _inFlight, ...rest } = journal;
  return rest;
}
