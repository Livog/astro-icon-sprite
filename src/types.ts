export interface IconNames {}

export type IconName = keyof IconNames extends never
  ? string
  : Extract<keyof IconNames, string> | (string & {});
