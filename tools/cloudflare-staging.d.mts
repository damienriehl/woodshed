export function executeStep<T>(input: { inspect: () => Promise<{ exists: boolean; id?: string }>; mutate: () => Promise<T>; owns: (state: { exists: boolean; id?: string }) => boolean }): Promise<{ reconciled: boolean; state: T | { exists: boolean; id?: string } }>;
export function runStagingOperation(options: Record<string, any>): Promise<any>;
