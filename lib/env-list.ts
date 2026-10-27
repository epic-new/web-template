/** A comma-separated environment variable as a list; unset or empty is `[]`. */
export function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
