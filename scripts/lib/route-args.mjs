// Keep raw, scope-bearing flags: an omitted default and an explicit default
// have different constraint hashes. Only presentation/approval flags are removed.
export const UNSCOPED_FLAGS = ['user-ok', 'json', 'dry', 'table', 'fresh', 'mode'];
export const flagArgs = (flags) => Object.entries(flags).flatMap(([key, value]) =>
  value === false || value == null ? [] : [`--${key}`, ...(value === true ? [] : [String(value)])]);
export const scopedFlags = (flags) => Object.fromEntries(Object.entries(flags).filter(([key]) => !UNSCOPED_FLAGS.includes(key)));
export const scopedRouteArgs = (task) => [task.category, ...flagArgs(scopedFlags(task.flags))];
