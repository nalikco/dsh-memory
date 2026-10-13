// Fail closed on typos, repeated flags and missing values before any I/O.
export function parseArgs(args, { values = [], switches = [] }) {
  const result = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!values.includes(flag) && !switches.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (Object.hasOwn(result, flag)) throw new Error(`Duplicate argument: ${flag}`);
    if (switches.includes(flag)) result[flag] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}
