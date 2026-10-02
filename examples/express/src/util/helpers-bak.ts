export const getError = (
  error: Record<string, string | string[]>,
  field: string,
) => {
  return Object.entries(error)
    .filter(([key]) => key === field)
    .map((entry) => ` ➜ ${entry[1]}`)
    .join("\n");
};

export type ValiError = { [key: string]: [string, ...string[]] };
export const isValiError = (v: unknown): v is ValiError => {
  return typeof v === "object";
};

type NormalValue = boolean | number | string | null;

/**
 * @see https://github.com/thednp/shorty/blob/master/src/misc/normalizeValue.ts
 */
export const normalizeValue = (value?: unknown): NormalValue => {
  if (["true", true].includes(value as boolean)) {
    return true;
  }

  if (["false", false].includes(value as boolean)) {
    return false;
  }

  if (["null", "", null, undefined].includes(value as string | undefined)) {
    return null;
  }

  if (value !== "" && !Number.isNaN(+(value as string))) {
    return Number(value);
  }

  // string / function / Element / object / undefined
  return value as NormalValue;
};
