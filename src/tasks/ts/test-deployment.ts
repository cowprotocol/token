import { RealTokenDeployParams, VirtualTokenDeployParams } from "../../ts";

export interface DeploymentInfo {
  realTokenDeployParams: RealTokenDeployParams;
  virtualTokenDeployParams: Omit<VirtualTokenDeployParams, "realToken">;
  realTokenAddress: string;
  virtualTokenAddress?: string;
}

export type OutputParamsJsonFormat = DeploymentInfo["realTokenDeployParams"] &
  DeploymentInfo["virtualTokenDeployParams"] &
  Pick<DeploymentInfo, "realTokenAddress" | "virtualTokenAddress">;

export const OUTPUT_FOLDER = "./output/test-deployment";
export const PARAMS_FILE = "params.json";
