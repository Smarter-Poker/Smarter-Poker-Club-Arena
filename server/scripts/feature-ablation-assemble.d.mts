/** Typed seam for the maintained JavaScript artifact producer. */
export function featureAdmissionArtifacts(input: {
  plan: any;
  assembly: any;
  validatePlan: (plan: any) => string[];
  validateDomain: (plan: any) => string[];
}): { files: Record<string, string>; admission: Record<string, any> };
