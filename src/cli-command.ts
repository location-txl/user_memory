export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;

export function cliCommand(home?: string) {
  return home ? `umem --home ${shellQuote(home)}` : "umem";
}
