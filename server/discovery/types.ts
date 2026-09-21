export interface RuntimePaths {
  readonly installRoot: string;
  readonly executable: string;
  readonly cliEntry: string;
  readonly serverEntry: string;
  readonly appPackage: string;
  readonly builtinProviderConfig: string;
}
export interface RuntimeIdentity {
  readonly platform: string;
  readonly appVersion: string;
  readonly cliVersion: string;
  readonly nodeVersion: string;
  readonly cliSha256: string;
  readonly serverSha256: string;
}
export interface DiscoveredRuntime {
  readonly paths: RuntimePaths;
  readonly identity: RuntimeIdentity;
  readonly compatibility: "supported" | "unsupported";
  readonly compatibilityReason: string;
  readonly writableInstallRoot: boolean;
}
export interface RuntimeSmokeResult {
  readonly passed: boolean;
  readonly cliVersion?: string;
  readonly error?: string;
}
