/** A required setting is missing. Names the variables only, never a value. */
export class MissingConfigError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`missing required settings: ${missing.join(', ')}`);
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

export const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
