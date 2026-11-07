export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;

export function cliCommand(home?: string, omitHome = false) {
  return home && !omitHome ? `umem --home ${shellQuote(home)}` : "umem";
}
