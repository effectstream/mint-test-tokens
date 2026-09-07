import { filter, firstValueFrom, timeout, type Observable } from "rxjs";

export interface DeploymentWalletState {
  isSynced: boolean;
  dust: {
    balance(at: Date): bigint;
  };
}

export interface DeploymentWalletStateSource<T extends DeploymentWalletState> {
  state(): Observable<T>;
}

export async function waitForFundedDeploymentWallet<T extends DeploymentWalletState>(
  source: DeploymentWalletStateSource<T>,
  timeoutMs: number,
  now: () => Date = () => new Date()
): Promise<T> {
  const state = await firstValueFrom(source.state().pipe(
    filter((value) => value.isSynced),
    timeout({ first: timeoutMs })
  ));
  if (state.dust.balance(now()) <= 0n) {
    throw new Error("The synchronized deployment wallet has no available DUST");
  }
  return state;
}
