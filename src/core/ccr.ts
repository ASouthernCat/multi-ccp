export interface CcrStatus {
  implemented: false;
  message: string;
}

export function getCcrStatusPlaceholder(): CcrStatus {
  return {
    implemented: false,
    message: "CCR management is planned for a later TypeScript CLI release. Use the legacy PowerShell ccp for CCR profiles for now."
  };
}
